/**
 * 密文格式与按密钥读写文件（会话历史、快照、日志的加密层）。
 *
 * 一行密文：SEMA1:<keyId>:<nonce base64>:<AES-256-GCM 密文 + 16 字节 tag 的 base64>
 * - 按行追加的文件（事件日志、模型调用日志、hook 会话记录）：原来的一行变成一行密文
 * - 整个读写的文件（会话历史、快照）：整个文件加密成一行
 * - 密文文件在原文件名后加 .enc，与明文同目录
 *
 * 格式是公开的：宿主或 hook 程序要读密文时，按上面的格式用同一把密钥自己解（标准 AES-256-GCM，不依赖本包）；
 * 本文件的函数只供内核内部用，读 hostConfig 里的密钥，有密钥写密文、没密钥写明文。
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { getEncryptionKey } from '../conf/hostConfig'
import { SemaError } from './errors'

const VERSION = 'SEMA1'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16

export const ENC_SUFFIX = '.enc'

/** 密钥：base64 字符串或 Buffer，必须是 32 字节 */
export function parseKey(key: string | Buffer): Buffer {
  const buf = typeof key === 'string' ? Buffer.from(key, 'base64') : key
  if (buf.length !== KEY_BYTES) {
    throw new SemaError('CONFIG_INVALID', `Encryption key must be ${KEY_BYTES} bytes (base64), got ${buf.length}`)
  }
  return buf
}

export function encryptLine(key: string | Buffer, data: string | Buffer, keyId = ''): string {
  if (keyId.includes(':') || /[\r\n]/.test(keyId)) {
    throw new SemaError('CONFIG_INVALID', `keyId must not contain ':' or line breaks: ${keyId}`)
  }
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', parseKey(key), nonce)
  const body = Buffer.concat([cipher.update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data), cipher.final(), cipher.getAuthTag()])
  return `${VERSION}:${keyId}:${nonce.toString('base64')}:${body.toString('base64')}`
}

export function isEncryptedLine(line: string): boolean {
  return line.startsWith(`${VERSION}:`)
}

export function decryptLine(key: string | Buffer, line: string): Buffer {
  const parts = line.trim().split(':')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SemaError('HISTORY_DECRYPT_FAILED', 'Not a valid encrypted line')
  }
  const nonce = Buffer.from(parts[2], 'base64')
  const body = Buffer.from(parts[3], 'base64')
  if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) {
    throw new SemaError('HISTORY_DECRYPT_FAILED', 'Encrypted line is corrupted')
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', parseKey(key), nonce)
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()])
  } catch {
    throw new SemaError('HISTORY_DECRYPT_FAILED', 'Decryption failed: wrong key or corrupted data')
  }
}

// ==================== 与宿主密钥绑定的便捷层 ====================

/** 当前是否开启加密（构造时传了 encryption） */
export function isEncryptionEnabled(): boolean {
  return getEncryptionKey() !== null
}

/** 用宿主密钥加密一行（二进制也可）；没有密钥时字符串原样返回、Buffer 转 utf8 返回 */
export function sealLine(data: string | Buffer): string {
  const enc = getEncryptionKey()
  if (enc) return encryptLine(enc.key, data, enc.keyId)
  return typeof data === 'string' ? data : data.toString('utf8')
}

/** 用宿主密钥解密一行；没有密钥抛 HISTORY_KEY_REQUIRED */
export function openLine(line: string): Buffer {
  const enc = getEncryptionKey()
  if (!enc) throw new SemaError('HISTORY_KEY_REQUIRED', 'File is encrypted but no encryption key was provided')
  return decryptLine(enc.key, line)
}

export function encName(filePath: string): string {
  return filePath + ENC_SUFFIX
}

export function isEncName(name: string): boolean {
  return name.endsWith(ENC_SUFFIX)
}

/** 去掉 .enc 后缀（没有则原样返回），用于按明文名判断文件类型 */
export function stripEnc(name: string): string {
  return isEncName(name) ? name.slice(0, -ENC_SUFFIX.length) : name
}

/** 文件名在加密时的实际名字：有密钥加 .enc，没有则原样 */
export function secureName(filePath: string): string {
  return isEncryptionEnabled() ? encName(filePath) : filePath
}

export interface SecurePathInfo {
  /** 实际存在（或将要写入）的路径 */
  path: string
  encrypted: boolean
  exists: boolean
}

/**
 * 按明文路径找实际文件：密文优先，其次明文；都不存在时返回将要写入的路径（有密钥则 .enc）
 */
export function resolveSecurePath(plainPath: string): SecurePathInfo {
  const enc = encName(plainPath)
  if (fs.existsSync(enc)) return { path: enc, encrypted: true, exists: true }
  if (fs.existsSync(plainPath)) return { path: plainPath, encrypted: false, exists: true }
  const encrypted = isEncryptionEnabled()
  return { path: encrypted ? enc : plainPath, encrypted, exists: false }
}

/**
 * 读整个文件：密文解密后返回，明文原样返回；不存在返回 null。
 * 密文无密钥抛 HISTORY_KEY_REQUIRED，解不开抛 HISTORY_DECRYPT_FAILED
 */
export function readSecureFile(plainPath: string): Buffer | null {
  const info = resolveSecurePath(plainPath)
  if (!info.exists) return null
  const raw = fs.readFileSync(info.path)
  return info.encrypted ? openLine(raw.toString('utf8')) : raw
}

/**
 * 写整个文件：有密钥写 .enc 并删除同名明文（升级后首次保存即完成迁移），没密钥写明文
 */
export function writeSecureFile(plainPath: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(plainPath), { recursive: true })
  if (isEncryptionEnabled()) {
    fs.writeFileSync(encName(plainPath), sealLine(data) + '\n')
    if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath)
  } else {
    fs.writeFileSync(plainPath, data)
  }
}

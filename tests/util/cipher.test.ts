import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate, writeFile, KEY, OTHER_KEY, throwsWithCode, rejectsWithCode } from '../helpers/isolate'

// 本进程不传 encryption：覆盖密文格式本身，以及"没传密钥"时各入口的行为
const { project } = isolate('cipher')

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cipher = require('../../src/util/cipher') as typeof import('../../src/util/cipher')
const { encryptLine, decryptLine, isEncryptedLine, sealLine, openLine, secureName, resolveSecurePath, readSecureFile, writeSecureFile } = cipher
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadHistory, resolveHistoryFile } = require('../../src/util/history') as typeof import('../../src/util/history')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getProjectHistoryDir } = require('../../src/util/savePath') as typeof import('../../src/util/savePath')

// ==================== 密文格式 ====================

test('加解密往返：字符串、Buffer、中文与换行都原样回来', () => {
  const text = '画一个内径 50 的法兰盘\n第二行'
  assert.equal(decryptLine(KEY, encryptLine(KEY, text)).toString('utf8'), text)

  const bin = Buffer.from([0, 1, 2, 255, 254])
  assert.deepEqual(decryptLine(KEY, encryptLine(KEY, bin)), bin)
})

test('一行密文是四段：版本、keyId、12 字节 nonce、密文；nonce 每次不同', () => {
  const a = encryptLine(KEY, 'x', 'k1')
  const b = encryptLine(KEY, 'x', 'k1')
  const parts = a.split(':')
  assert.equal(parts.length, 4)
  assert.equal(parts[0], 'SEMA1')
  assert.equal(parts[1], 'k1')
  assert.equal(Buffer.from(parts[2], 'base64').length, 12)
  assert.notEqual(a, b)
  assert.equal(isEncryptedLine(a), true)
  assert.equal(isEncryptedLine('{"plain":true}'), false)

  // 不传 keyId 时第二段为空
  assert.equal(encryptLine(KEY, 'x').split(':')[1], '')
})

test('密钥不对、密文被改、根本不是密文：都报 HISTORY_DECRYPT_FAILED', () => {
  const line = encryptLine(KEY, 'secret')
  throwsWithCode(() => decryptLine(OTHER_KEY, line), 'HISTORY_DECRYPT_FAILED')

  const parts = line.split(':')
  const body = Buffer.from(parts[3], 'base64')
  body[0] ^= 0xff
  throwsWithCode(() => decryptLine(KEY, `${parts[0]}:${parts[1]}:${parts[2]}:${body.toString('base64')}`), 'HISTORY_DECRYPT_FAILED')

  throwsWithCode(() => decryptLine(KEY, '{"messages":[]}'), 'HISTORY_DECRYPT_FAILED')
})

test('密钥长度不对、keyId 含冒号：CONFIG_INVALID', () => {
  throwsWithCode(() => encryptLine('c2hvcnQ=', 'x'), 'CONFIG_INVALID')
  throwsWithCode(() => encryptLine(KEY, 'x', 'a:b'), 'CONFIG_INVALID')
})

// ==================== 没传密钥 ====================

test('没传密钥：写明文、不加 .enc、sealLine 原样返回', () => {
  assert.equal(sealLine('plain'), 'plain')
  assert.equal(secureName('/a/b.json'), '/a/b.json')

  const target = join(project, '.sema', 'nokey.json')
  writeSecureFile(target, '{"a":1}')
  assert.equal(existsSync(target), true)
  assert.equal(existsSync(target + '.enc'), false)
  assert.equal(readFileSync(target, 'utf8'), '{"a":1}')
  assert.equal(readSecureFile(target)?.toString('utf8'), '{"a":1}')
  assert.deepEqual(resolveSecurePath(join(project, 'none.json')), { path: join(project, 'none.json'), encrypted: false, exists: false })
})

test('没传密钥却遇到密文：openLine / readSecureFile 报 HISTORY_KEY_REQUIRED', () => {
  const line = encryptLine(OTHER_KEY, 'x')
  throwsWithCode(() => openLine(line), 'HISTORY_KEY_REQUIRED')

  const target = join(project, '.sema', 'enc-only.json')
  writeFile(target + '.enc', line + '\n')
  throwsWithCode(() => readSecureFile(target), 'HISTORY_KEY_REQUIRED')
})

test('没传密钥却遇到密文历史：createSession 这一层拿到 HISTORY_KEY_REQUIRED，文件原样保留', async () => {
  // 产品某次启动没传密钥，磁盘上是上次加密保存的会话
  const dir = getProjectHistoryDir(project)
  const encFile = join(dir, 'ab12cd34.json.enc')
  writeFile(encFile, encryptLine(OTHER_KEY, JSON.stringify({ messages: [{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } }] })) + '\n')

  const resolved = resolveHistoryFile('ab12cd34', project)
  assert.equal(resolved.exists, true)
  assert.equal(resolved.encrypted, true)
  assert.equal(resolved.path, encFile)

  await rejectsWithCode(loadHistory('ab12cd34', project), 'HISTORY_KEY_REQUIRED')
  assert.equal(existsSync(encFile), true)
})

test('同名明文和密文都在时密文优先', () => {
  const target = join(project, '.sema', 'both.json')
  writeFile(target, 'plain')
  writeFile(target + '.enc', encryptLine(OTHER_KEY, 'enc'))
  assert.equal(resolveSecurePath(target).path, target + '.enc')
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Isolated {
  /** 独立的 SEMA_ROOT（~/.sema 的替身） */
  root: string
  /** 独立的项目目录，带 .sema 子目录 */
  project: string
}

/**
 * 建独立的 SEMA_ROOT 与项目目录。
 * 必须在 require 任何 src 模块之前调用：SEMA_ROOT 在首次 getSemaRootDir() 时缓存，
 * 各管理器是进程单例、在首次 getXManager() 时读 hostConfig，所以每个场景一个测试文件（一个进程）
 */
export function isolate(prefix: string): Isolated {
  const root = mkdtempSync(join(tmpdir(), `sema-${prefix}-`))
  process.env.SEMA_ROOT = root
  const project = join(root, 'project')
  mkdirSync(join(project, '.sema'), { recursive: true })
  return { root, project }
}

export function writeFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

/** 32 字节随机密钥的 base64（与方案示例相同） */
export const KEY = 'BFTcT9C8rqXC+rVlQI2QKIFmrVi5r9PxX3FA8recV60='
/** 另一把密钥：模拟重装后换钥 */
export const OTHER_KEY = Buffer.alloc(32, 7).toString('base64')

/** 断言同步调用抛出带指定 code 的 SemaError */
export function throwsWithCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.equal((err as { code?: string }).code, code, `expected code ${code}, got ${(err as Error).message}`)
    return true
  })
}

/** 断言 Promise 以带指定 code 的 SemaError 失败 */
export async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.equal((err as { code?: string }).code, code, `expected code ${code}, got ${(err as Error).message}`)
    return true
  })
}

export function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

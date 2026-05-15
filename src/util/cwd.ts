import { cwd } from 'process'
import { canonicalizeFilePath } from './file'
import { IS_WIN } from './platform'

let originalCwd = cwd()

/**
 * 设置原始工作目录（静态值，一旦设置就不会改变）
 *
 */
export function updateInitialCwd(cwd: string): void {
  originalCwd = IS_WIN ? canonicalizeFilePath(cwd) : cwd
}

/**
 * 获取原始工作目录（返回进程启动时的工作目录，存储在全局状态中）
 *
 */
export function readInitialCwd(): string {
  return originalCwd
}

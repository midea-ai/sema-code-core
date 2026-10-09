import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { getOneShotShellRuntimeInfo } from './shell'

// kill / 隔离 spawn 放在 kill.ts，shell.ts 也要用，避免与本文件形成循环引用
export { killProcess, getDetachedSpawnOptions } from './kill'

// 内存输出上限 2MB
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
// 任务输出目录
export const TASK_OUTPUT_DIR = path.join(os.tmpdir(), 'sema-tasks')

// 确保任务输出目录存在
export function ensureTaskDir() {
  fs.mkdirSync(TASK_OUTPUT_DIR, { recursive: true })
}

// 获取 shell 信息（用于独立 spawn 场景）
export function getShellForSpawn(): { bin: string; args: string[] } {
  const { bin, args } = getOneShotShellRuntimeInfo()
  return { bin, args }
}

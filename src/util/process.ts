import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execSync, type ChildProcess } from 'child_process'
import { IS_WIN } from './platform'
import { logWarn } from './log'

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
  if (IS_WIN) {
    return { bin: process.env.ComSpec || 'cmd.exe', args: ['/c'] }
  }
  return { bin: process.env.SHELL || '/bin/bash', args: ['-c'] }
}

// kill 进程（跨平台），返回是否成功
export function killProcess(proc: ChildProcess): boolean {
  if (!proc.pid) return false
  try {
    if (IS_WIN) {
      try {
        execSync(`taskkill /f /t /pid ${proc.pid}`, { stdio: 'ignore', timeout: 5000 })
      } catch {
        proc.kill('SIGTERM')
      }
    } else {
      proc.kill('SIGTERM')
    }
    return true
  } catch (error) {
    logWarn(`killProcess 失败: ${error}`)
    return false
  }
}

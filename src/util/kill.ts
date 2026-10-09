import { execSync, type ChildProcess, type SpawnOptions } from 'child_process'
import { IS_WIN } from './platform'
import { logWarn } from './log'

/** SIGTERM 发出后等待多久仍未退出则补发 SIGKILL */
const FORCE_KILL_DELAY_MS = 2000

/**
 * 子进程隔离用的 spawn 选项：
 * POSIX 下 detached 让子进程独占进程组（setsid），终止时可按负 pid 整组回收孙进程；
 * Windows 隐藏窗口，整树终止由 taskkill /t 负责。
 */
export function getDetachedSpawnOptions(): Pick<SpawnOptions, 'detached' | 'windowsHide'> {
  return IS_WIN ? { windowsHide: true } : { detached: true }
}

function isExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

/** POSIX：优先按进程组发信号（要求以 detached 方式 spawn），进程组不存在时回落到单进程 */
function signalPosix(proc: ChildProcess, signal: NodeJS.Signals): void {
  try {
    process.kill(-proc.pid!, signal)
  } catch {
    proc.kill(signal)
  }
}

/**
 * 终止子进程及其整棵进程树，返回是否成功发出信号。
 * Windows：taskkill /f /t 同步强杀整树。
 * POSIX：先整组 SIGTERM，FORCE_KILL_DELAY_MS 后再整组补一次 SIGKILL（已退出的进程组会 ESRCH，无副作用；
 * 定时器 unref，不阻塞宿主退出）。
 */
export function killProcess(proc: ChildProcess): boolean {
  if (!proc.pid) return false
  try {
    if (IS_WIN) {
      try {
        execSync(`taskkill /f /t /pid ${proc.pid}`, { stdio: 'ignore', timeout: 5000 })
      } catch {
        proc.kill('SIGTERM')
      }
      return true
    }

    if (!isExited(proc)) signalPosix(proc, 'SIGTERM')
    const timer = setTimeout(() => {
      try {
        signalPosix(proc, 'SIGKILL')
      } catch (error) {
        logWarn(`killProcess SIGKILL 失败 pid=${proc.pid}: ${error}`)
      }
    }, FORCE_KILL_DELAY_MS)
    timer.unref()
    return true
  } catch (error) {
    logWarn(`killProcess 失败: ${error}`)
    return false
  }
}

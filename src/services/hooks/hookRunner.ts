/**
 * Hook 命令执行器与输出解析
 *
 * 一次性子进程执行（不复用 PersistentShell：其为单例长驻共享 shell，有状态且命令排队），
 * stdin 写入 JSON payload，输出走通用 hooks 协议（exit code + stdout JSON 两条通道）。
 */

import { spawn, ChildProcess } from 'child_process'
import { readInitialCwd } from '../../util/cwd'
import { logWarn } from '../../util/log'
import { getShellForSpawn, killProcess } from '../../util/process'
import { IS_WIN } from '../../util/platform'
import { HookExecResult, HookOutcome } from '../../types/hook'

// 单流输出上限 1MB
const MAX_STREAM_BYTES = 1024 * 1024
// additionalContext 长度上限（超出截断并记 warning）
export const MAX_ADDITIONAL_CONTEXT_CHARS = 10_000
// SIGTERM 后升级 SIGKILL 的宽限期
const KILL_GRACE_MS = 2000
// SIGKILL 后强制 settle 的期限（不依赖 close/exit 事件到达，保证 Promise 有界结束）
const SETTLE_GRACE_MS = 2000

// 不可阻断的事件（exit 2 / decision block 降级为 pass 并打 blockIgnored 标）。
// Stop 暂不支持续驱（block stop 强迫模型继续），只作观察型埋点
const NON_BLOCKABLE_EVENTS = new Set(['SessionStart', 'SessionEnd', 'Stop'])

/**
 * 终止 hook 进程。POSIX 下 hook 以独立进程组运行（spawn detached），
 * 负 pid 整组终止（含孙进程）；Windows 复用 taskkill /f /t（已是整树强杀）
 */
function terminateHookProcess(proc: ChildProcess, force: boolean): void {
  if (!proc.pid) return
  try {
    if (IS_WIN) {
      killProcess(proc)
    } else {
      try {
        process.kill(-proc.pid, force ? 'SIGKILL' : 'SIGTERM')
      } catch {
        // 进程组终止失败（如进程已退出）回落单进程 kill
        try {
          proc.kill(force ? 'SIGKILL' : 'SIGTERM')
        } catch { /* 已退出 */ }
      }
    }
  } catch (error) {
    logWarn(`[Hook] 终止 hook 进程失败: ${error}`)
  }
}

/**
 * 以一次性子进程执行 hook 命令，payload 经 stdin 写入
 */
export function executeHookCommand(
  command: string,
  payloadJson: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<HookExecResult> {
  return new Promise(resolve => {
    const startTime = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let terminating = false
    let timeoutTimer: NodeJS.Timeout | null = null
    let escalationTimer: NodeJS.Timeout | null = null
    let deadlineTimer: NodeJS.Timeout | null = null
    let proc: ChildProcess

    const finish = (result: Omit<HookExecResult, 'durationMs'>) => {
      if (settled) return
      settled = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (escalationTimer) clearTimeout(escalationTimer)
      if (deadlineTimer) clearTimeout(deadlineTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ ...result, durationMs: Date.now() - startTime })
    }

    // 终止升级链（配置超时与 AbortSignal 中断共用同一入口）：
    // SIGTERM → KILL_GRACE → SIGKILL → SETTLE_GRACE 到期直接 settle。
    // 最后一级不依赖任何进程事件，是 Promise 有界结束的确定性保证
    const beginTermination = () => {
      if (terminating || settled) return
      terminating = true
      terminateHookProcess(proc, false)
      escalationTimer = setTimeout(() => {
        if (settled) return
        terminateHookProcess(proc, true)
        deadlineTimer = setTimeout(() => {
          logWarn(`[Hook] 进程未在期限内退出，强制结束等待（可能残留进程）: ${command}`)
          finish({ exitCode: null, stdout, stderr, timedOut, failedToSpawn: !timedOut })
        }, SETTLE_GRACE_MS)
      }, KILL_GRACE_MS)
    }

    const onAbort = () => beginTermination()

    const { bin, args } = getShellForSpawn()
    try {
      proc = spawn(bin, [...args, command], {
        cwd: readInitialCwd(),
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX 下 detached 使 hook 独占进程组，便于整组终止；
        // 子进程不会随宿主退出自动回收，与非 detached 行为一致（SessionEnd 本为尽力而为）
        ...(IS_WIN ? { windowsHide: true } : { detached: true }),
      })
    } catch (error) {
      logWarn(`[Hook] spawn 失败: ${error}`)
      finish({ exitCode: null, stdout: '', stderr: '', timedOut: false, failedToSpawn: true })
      return
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true
      beginTermination()
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) beginTermination()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    proc.on('error', error => {
      logWarn(`[Hook] 子进程执行失败: ${error}`)
      finish({ exitCode: null, stdout, stderr, timedOut, failedToSpawn: true })
    })

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString('utf-8')
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString('utf-8')
    })

    // EPIPE 防护：脚本不读 stdin 直接退出时 write 会触发 error
    proc.stdin?.on('error', () => {})
    proc.stdin?.write(payloadJson)
    proc.stdin?.end()

    proc.on('close', code => {
      // abort 场景按执行失败处理（外层 fail-open）
      const abortedExternally = signal?.aborted === true && !timedOut
      finish({
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        failedToSpawn: abortedExternally,
      })
    })
  })
}

/**
 * 解析单条 hook 的执行输出（exit code + stdout JSON 双通道）
 */
export function parseHookOutput(event: string, exec: HookExecResult): HookOutcome {
  if (exec.timedOut || exec.failedToSpawn) {
    return { kind: 'error' }
  }

  // exit 2：阻断，stderr 作为原因；SessionStart/SessionEnd 不可阻断，降级 pass
  if (exec.exitCode === 2) {
    if (NON_BLOCKABLE_EVENTS.has(event)) {
      logWarn(`[Hook] ${event} 不可阻断，忽略 exit 2（stderr: ${exec.stderr.trim().slice(0, 200)}）`)
      return { kind: 'pass', blockIgnored: true }
    }
    return { kind: 'block', reason: exec.stderr.trim() || `Blocked by ${event} hook` }
  }

  // 其他非 0 exit code（含 null）：hook 执行失败，fail-open（exit 1 明确不阻断）
  if (exec.exitCode !== 0) {
    return { kind: 'error' }
  }

  // exit 0：stdout 若为单个合法 JSON 对象则结构化解析，否则按纯文本处理
  const rawStdout = exec.stdout.trim()
  let parsed: Record<string, unknown> | null = null
  if (rawStdout.startsWith('{')) {
    try {
      const obj = JSON.parse(rawStdout)
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        parsed = obj as Record<string, unknown>
      }
    } catch {
      // 非法 JSON 按纯文本处理
    }
  }

  if (!parsed) {
    // 纯文本：SessionStart / UserPromptSubmit 作为附加上下文注入，其他事件忽略
    if (rawStdout && (event === 'SessionStart' || event === 'UserPromptSubmit')) {
      return { kind: 'pass', additionalContext: truncateContext(rawStdout) }
    }
    return { kind: 'pass' }
  }

  const outcome: HookOutcome = { kind: 'pass' }

  // 通用字段（顶层）；未识别字段（continue/stopReason/updatedInput 等）一律静默忽略
  if (typeof parsed.systemMessage === 'string') outcome.systemMessage = parsed.systemMessage
  if (typeof parsed.suppressOutput === 'boolean') outcome.suppressOutput = parsed.suppressOutput
  if (parsed.decision === 'block') {
    if (NON_BLOCKABLE_EVENTS.has(event)) {
      logWarn(`[Hook] ${event} 不可阻断，忽略 decision: block`)
      outcome.blockIgnored = true
    } else {
      outcome.kind = 'block'
      outcome.reason = typeof parsed.reason === 'string' ? parsed.reason : `Blocked by ${event} hook`
    }
  }

  // 事件专属字段（hookSpecificOutput 壳，hookEventName 为判别字段）
  const hso = parsed.hookSpecificOutput
  if (hso && typeof hso === 'object' && !Array.isArray(hso)) {
    const shell = hso as Record<string, unknown>
    if (shell.hookEventName !== undefined && shell.hookEventName !== event) {
      logWarn(`[Hook] hookSpecificOutput.hookEventName (${shell.hookEventName}) 与事件 ${event} 不匹配，忽略`)
    } else {
      const pd = shell.permissionDecision
      if (pd !== undefined) {
        if (pd === 'allow' || pd === 'deny' || pd === 'ask') {
          outcome.decision = pd
          if (typeof shell.permissionDecisionReason === 'string') {
            outcome.reason = shell.permissionDecisionReason
          }
        } else {
          logWarn(`[Hook] 未识别的 permissionDecision: ${pd}，忽略`)
        }
      }
      if (typeof shell.additionalContext === 'string' && shell.additionalContext) {
        outcome.additionalContext = truncateContext(shell.additionalContext)
      }
    }
  }

  return outcome
}

/**
 * additionalContext 截断（上限 10k 字符）
 */
export function truncateContext(text: string): string {
  if (text.length <= MAX_ADDITIONAL_CONTEXT_CHARS) return text
  logWarn(`[Hook] additionalContext 超出 ${MAX_ADDITIONAL_CONTEXT_CHARS} 字符上限，已截断`)
  return text.slice(0, MAX_ADDITIONAL_CONTEXT_CHARS)
}

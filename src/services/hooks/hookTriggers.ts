/**
 * Hook 埋点入口
 *
 * 核心链路仅 import 本模块。埋点稳定性硬约束：
 * ① 无匹配条目零开销早退；② 整体 try/catch fail-open，
 * 内部任何错误只记日志不上抛——未配置 hooks 的现有用户零影响。
 */

import { getEventBus } from '../../events/EventSystem'
import { HookNoticeData } from '../../events/types'
import { toGenericToolName } from '../../prompt/toolAliases'
import { LoadedHookEntry } from '../../types/hook'
import { readInitialCwd } from '../../util/cwd'
import { logInfo, logWarn } from '../../util/log'
import { getHooksManager } from './hooksManager'
import {
  MAX_ADDITIONAL_CONTEXT_CHARS,
  executeHookCommand,
  parseHookOutput,
  truncateContext,
} from './hookRunner'

const MAIN_AGENT = 'main'

// 聚合结果（单次事件触发内，条目顺序执行的汇总）
interface HookRunAggregate {
  // 是否存在匹配且可执行的条目并进入了执行链路（fail-open/被中断时仍为 true；
  // 未启用/未配置/未命中时为 false，保证未配置路径行为零差异）
  ran: boolean
  blocked: boolean
  blockReason?: string
  decision: 'allow' | 'deny' | 'ask' | 'none'
  decisionReason?: string
  additionalContext: string[]
}

function neutralAggregate(): HookRunAggregate {
  return { ran: false, blocked: false, decision: 'none', additionalContext: [] }
}

/**
 * fail-open 总兜底：入口全部逻辑（含单例获取、开关读取）都在其中执行，
 * 任何异常只记日志并返回中性结果，绝不上抛到核心链路
 */
async function safeRun<T>(neutral: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    logWarn(`[Hook] 内部错误(fail-open): ${error}`)
    return neutral
  }
}

function emitNotice(sessionId: string, data: HookNoticeData): void {
  getEventBus().emit('hook:notice', data, sessionId)
}

/**
 * 顺序执行单个事件下的全部命中条目并聚合结果
 * - 第一个阻断（block / deny）立即停止后续条目
 * - 聚合优先级：deny > ask > allow > none（ask 保守优先于 allow）
 */
async function runEventHooks(
  event: string,
  sessionId: string,
  payload: Record<string, unknown>,
  entries: LoadedHookEntry[],
  signal?: AbortSignal,
): Promise<HookRunAggregate> {
  const aggregate: HookRunAggregate = { ran: true, blocked: false, decision: 'none', additionalContext: [] }
  const payloadJson = JSON.stringify(payload)

  for (const entry of entries) {
    // 中断后短路剩余条目，避免逐个 spawn 出立即被 kill 的进程
    if (signal?.aborted) break
    const exec = await executeHookCommand(entry.command, payloadJson, entry.timeoutMs, signal)
    const outcome = parseHookOutput(event, exec)

    // 审计日志（PreToolUse / PermissionRequest 的 allow 等于把权限决策交给 hook 脚本，日志不可省）
    logInfo(
      `[Hook][audit] event=${event} agent=${String(payload.agent_id ?? MAIN_AGENT)} ` +
      `source=${entry.source} command="${entry.command}" timeoutMs=${entry.timeoutMs} ` +
      `exit=${exec.exitCode} timedOut=${exec.timedOut} kind=${outcome.kind} ` +
      `decision=${outcome.decision ?? '-'} duration=${exec.durationMs}ms`
    )

    if (exec.timedOut) {
      emitNotice(sessionId, {
        kind: 'warning',
        hookEvent: event,
        message: `hook 执行超时（${entry.timeoutMs / 1000}s）已终止: ${entry.command}`,
        command: entry.command,
        source: entry.source,
      })
    }

    // 不可阻断事件上的 block 输出被忽略：告警而非静默，
    // 避免用户从其他工具迁移来的续驱配置（Stop + exit 2）看似生效实则无效
    if (outcome.blockIgnored) {
      emitNotice(sessionId, {
        kind: 'warning',
        hookEvent: event,
        message: `${event} 事件不支持阻断，hook 的 block 输出已忽略: ${entry.command}`,
        command: entry.command,
        source: entry.source,
      })
    }

    if (outcome.systemMessage) {
      emitNotice(sessionId, {
        kind: 'systemMessage',
        hookEvent: event,
        message: outcome.systemMessage,
        command: entry.command,
        source: entry.source,
      })
    }

    if (outcome.additionalContext) {
      aggregate.additionalContext.push(outcome.additionalContext)
    }

    // fail-closed 条目：hook 执行失败按阻断处理
    const effectiveKind =
      outcome.kind === 'error' && entry.failClosed ? ('block' as const) : outcome.kind
    if (effectiveKind === 'block') {
      aggregate.blocked = true
      aggregate.blockReason =
        outcome.kind === 'error'
          ? `hook failed (fail-closed): ${entry.command}`
          : outcome.reason
      break
    }

    if (outcome.decision === 'deny') {
      aggregate.decision = 'deny'
      aggregate.decisionReason = outcome.reason
      break
    }
    if (outcome.decision === 'ask') {
      aggregate.decision = 'ask'
      if (outcome.reason) aggregate.decisionReason = outcome.reason
    } else if (outcome.decision === 'allow' && aggregate.decision === 'none') {
      aggregate.decision = 'allow'
      if (outcome.reason) aggregate.decisionReason = outcome.reason
    }
  }

  // 聚合后总量再做一次截断
  const total = aggregate.additionalContext.join('\n\n')
  if (total.length > MAX_ADDITIONAL_CONTEXT_CHARS) {
    aggregate.additionalContext = [truncateContext(total)]
  }

  return aggregate
}

function buildCommonPayload(event: string, sessionId: string, agentId: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    cwd: readInitialCwd(),
    hook_event_name: event,
    agent_id: agentId,
  }
}

/**
 * 工具类事件的统一触发（PreToolUse / PostToolUse / PostToolUseFailure / PermissionRequest）
 */
async function runToolEventHooks(
  event: string,
  sessionId: string,
  agentId: string,
  semaToolName: string,
  extraPayload: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<HookRunAggregate> {
  // ran 在 safeRun 外持有：条目进入执行链路后即置位，
  // 后续执行失败/被中断（fail-open 返回中性结果）时 ran 仍为 true
  let ran = false
  const result = await safeRun(neutralAggregate(), async () => {
    const manager = getHooksManager()
    await manager.ready()
    const genericToolName = toGenericToolName(semaToolName)
    const entries = manager.getMatchedEntries(event, genericToolName, semaToolName)
    if (entries.length === 0) return neutralAggregate()
    ran = true

    const payload = {
      ...buildCommonPayload(event, sessionId, agentId),
      tool_name: genericToolName,
      sema_tool_name: semaToolName,
      ...extraPayload,
    }
    return runEventHooks(event, sessionId, payload, entries, signal)
  })
  return { ...result, ran }
}

// ==================== 8 个事件入口 ====================

/**
 * SessionStart：engine session 初始化成功后触发；不可阻断
 * @returns 注入模型上下文的 additionalContext，无则 null
 */
export async function fireSessionStart(sessionId: string): Promise<string | null> {
  return safeRun(null as string | null, async () => {
    const manager = getHooksManager()
    await manager.ready()
    const entries = manager.getMatchedEntries('SessionStart')
    if (entries.length === 0) return null

    const payload = { ...buildCommonPayload('SessionStart', sessionId, MAIN_AGENT), source: 'startup' }
    const aggregate = await runEventHooks('SessionStart', sessionId, payload, entries)
    return aggregate.additionalContext.length > 0 ? aggregate.additionalContext.join('\n\n') : null
  })
}

/**
 * UserPromptSubmit：用户输入进入命令处理或模型处理前触发
 * block → 丢弃本次输入（原因经 hook:notice 展示给用户，由调用方发出）
 */
export async function fireUserPromptSubmit(
  sessionId: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<{ blocked: boolean; reason?: string; additionalContext?: string; ran: boolean }> {
  const neutral = { blocked: false }
  let ran = false
  const result = await safeRun<{ blocked: boolean; reason?: string; additionalContext?: string }>(neutral, async () => {
    const manager = getHooksManager()
    await manager.ready()
    const entries = manager.getMatchedEntries('UserPromptSubmit')
    if (entries.length === 0) return neutral
    ran = true

    const payload = { ...buildCommonPayload('UserPromptSubmit', sessionId, MAIN_AGENT), prompt }
    const aggregate = await runEventHooks('UserPromptSubmit', sessionId, payload, entries, signal)
    return {
      blocked: aggregate.blocked,
      reason: aggregate.blockReason,
      additionalContext:
        aggregate.additionalContext.length > 0 ? aggregate.additionalContext.join('\n\n') : undefined,
    }
  })
  return { ...result, ran }
}

/**
 * PreToolUse：工具执行前触发
 * deny → 工具不执行，原因以 is_error tool_result 回给模型（exit 2 等价 deny）
 * allow → 跳过权限询问直接执行；ask/无输出 → 走原权限流程
 */
export async function firePreToolUse(
  sessionId: string,
  agentId: string,
  semaToolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<{ decision: 'allow' | 'deny' | 'none'; reason?: string; ran: boolean }> {
  const aggregate = await runToolEventHooks(
    'PreToolUse', sessionId, agentId, semaToolName, { tool_input: input }, signal,
  )
  if (aggregate.blocked) {
    return { decision: 'deny', reason: aggregate.blockReason, ran: aggregate.ran }
  }
  if (aggregate.decision === 'allow' || aggregate.decision === 'deny') {
    return { decision: aggregate.decision, reason: aggregate.decisionReason, ran: aggregate.ran }
  }
  return { decision: 'none', ran: aggregate.ran }
}

/**
 * PostToolUse：工具执行成功后触发
 * @returns contextBlocks 注入模型上下文的文本块（exit 2 的 stderr 与 additionalContext）
 */
export async function firePostToolUse(
  sessionId: string,
  agentId: string,
  semaToolName: string,
  input: unknown,
  response: unknown,
  signal?: AbortSignal,
): Promise<{ contextBlocks: string[] }> {
  const aggregate = await runToolEventHooks(
    'PostToolUse', sessionId, agentId, semaToolName, { tool_input: input, tool_response: response }, signal,
  )
  const contextBlocks = [...aggregate.additionalContext]
  if (aggregate.blocked && aggregate.blockReason) {
    // 工具已执行完，无法撤销，stderr 仅回灌模型
    contextBlocks.push(`[PostToolUse hook] ${aggregate.blockReason}`)
  }
  return { contextBlocks }
}

/**
 * PostToolUseFailure：工具执行抛错后触发（可注入纠错提示）
 */
export async function firePostToolUseFailure(
  sessionId: string,
  agentId: string,
  semaToolName: string,
  input: unknown,
  error: string,
  signal?: AbortSignal,
): Promise<{ contextBlocks: string[] }> {
  const aggregate = await runToolEventHooks(
    'PostToolUseFailure', sessionId, agentId, semaToolName, { tool_input: input, error }, signal,
  )
  const contextBlocks = [...aggregate.additionalContext]
  if (aggregate.blocked && aggregate.blockReason) {
    contextBlocks.push(`[PostToolUseFailure hook] ${aggregate.blockReason}`)
  }
  return { contextBlocks }
}

/**
 * PermissionRequest：权限系统即将向用户发起询问前触发
 * allow → 批准（等价用户 agree，不产生永久授权）；deny → 拒绝（exit 2 等价 deny）；
 * ask/无输出 → 保持正常询问流程
 */
export async function firePermissionRequest(
  sessionId: string,
  agentId: string,
  semaToolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<{ decision: 'allow' | 'deny' | 'none'; reason?: string }> {
  const aggregate = await runToolEventHooks(
    'PermissionRequest', sessionId, agentId, semaToolName, { tool_input: input }, signal,
  )
  if (aggregate.blocked) {
    return { decision: 'deny', reason: aggregate.blockReason }
  }
  if (aggregate.decision === 'allow' || aggregate.decision === 'deny') {
    return { decision: aggregate.decision, reason: aggregate.decisionReason }
  }
  return { decision: 'none' }
}

/**
 * Stop：主链路一轮处理自然完成并转入 idle 时触发，fire-and-forget（观察型埋点）。
 * 不可阻断（暂不支持续驱，block 输出忽略并告警）、不注入上下文；
 * systemMessage 照常经 hook:notice 展示。中断的轮次与排队输入接续的轮次不触发。
 */
export function fireStop(sessionId: string): void {
  void safeRun(null, async () => {
    const manager = getHooksManager()
    await manager.ready()
    const entries = manager.getMatchedEntries('Stop')
    if (entries.length === 0) return null

    // stop_hook_active 对齐通用 hooks 字段形状（无续驱恒为 false），方便脚本跨端复用
    const payload = { ...buildCommonPayload('Stop', sessionId, MAIN_AGENT), stop_hook_active: false }
    await runEventHooks('Stop', sessionId, payload, entries)
    return null
  })
}

/**
 * SessionEnd：会话关闭时触发，fire-and-forget（不可阻断，输出忽略）
 */
export function fireSessionEnd(sessionId: string): void {
  void safeRun(null, async () => {
    // async 函数体在首个 await 前同步执行：缓存就绪时条目在本调用返回前即被同步捕获，
    // 不受 SemaCore.dispose 同步链路随后清空 hooksManager 缓存的影响（捕获的是过滤后的新数组）。
    // 缓存未就绪（会话刚创建即销毁的窄窗口）走异步加载兜底，此时仍可能因 dispose 竞态跳过——
    // SessionEnd 本为 best-effort（宿主进程随即退出也可能截断 hook 执行），该残余可接受
    const manager = getHooksManager()
    if (!manager.isReady()) {
      await manager.ready()
    }
    const entries = manager.getMatchedEntries('SessionEnd')
    if (entries.length === 0) return null

    const payload = { ...buildCommonPayload('SessionEnd', sessionId, MAIN_AGENT), reason: 'dispose' }
    await runEventHooks('SessionEnd', sessionId, payload, entries)
    return null
  })
}

import type Anthropic from '@anthropic-ai/sdk'
import { AiMessage, Message } from '../types/message'
import { countTokens } from './tokens'
import { buildUserMsg, prepareMessagesForApi, REQ_INTERRUPT_MSG } from './message'
import { queryLLM } from '../services/api/queryLLM'
import { getModelManager } from '../manager/ModelManager'
import { logDebug, logError, logInfo, logWarn } from './log'
import { getEventBus } from '../events/EventSystem'
import { CompactExecData, CompactMicroData } from '../events/types'
import { microCompactMessages, estimateTokensFromText } from './microcompact'
import { Tool } from '../tools/base/Tool'
import { z } from 'zod'
import { getTokens } from './tokens'
import {
  buildCompressionPrompt,
  SKILL_CONTEXT_NOTICE,
  COMPACT_RESUME_NOTICE,
  LATEST_USER_INSTRUCTION_NOTICE,
  COMPACT_SUMMARY_LEAD,
  CONTEXT_TRUNCATED_NOTICE_LEAD,
  wrapCompactSummary,
} from '../prompt/compact'
import { generatePostCompactReminders } from '../services/agents/genSystemReminder'
import { TOOL_NAME_SKILL } from '../prompt/tool'
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from '../prompt/define'

const defaultCompactDependencies = {
  queryLLM,
  getModelManager,
  getEventBus,
}

const compactDependencies = { ...defaultCompactDependencies }

export const __compactTestHooks = {
  setDependencies(dependencies: Partial<typeof defaultCompactDependencies>): void {
    Object.assign(compactDependencies, dependencies)
  },
  resetDependencies(): void {
    Object.assign(compactDependencies, defaultCompactDependencies)
  },
}

/**
 * 触发自动上下文压缩的阈值比例
 * 当上下文使用量超过模型限制的75%时，将自动激活紧凑化处理
 * 提前触发压缩以避免接近token限制时的API调用失败
 */
const AUTO_COMPACT_THRESHOLD_RATIO = 0.75

/**
 * 自动压缩时原样保留的最近工具轮次数（一个轮次 = assistant(tool_use) + 紧随的 tool_result user 消息）。
 * 最后一条 assistant 之后的未消费批次另行无条件保留，不计入此数。
 */
const COMPACT_KEEP_RECENT_TOOL_ROUNDS = 4

// 图片块固定估算，与 microcompact 口径一致（勿按 base64 长度折算）
const IMAGE_BLOCK_TOKEN_ESTIMATE = 1500

export type CompactTruncatedReason =
  | 'EMPTY_SUMMARY'
  | 'INVALID_COMPACT_RESPONSE'
  | 'COMPACT_ERROR'

export type CompactResult =
  | {
      kind: 'unchanged'
      messages: Message[]
    }
  | {
      kind: 'summary'
      messages: Message[]
      summary: string
    }
  | {
      kind: 'truncated'
      messages: Message[]
      reason: CompactTruncatedReason
    }
  | {
      kind: 'failed'
      error: unknown
    }

export type AutoCompactResult =
  | {
      changed: true
      messages: Message[]
      mode: 'summary' | 'truncated'
    }
  | {
      changed: false
      messages: Message[]
      error?: unknown
    }

type CompactSummaryResult =
  | {
      kind: 'summary'
      messages: Message[]
      summary: string
    }
  | {
      kind: 'invalid'
      reason: Exclude<CompactTruncatedReason, 'COMPACT_ERROR'>
    }

function getContextLimit(sessionId?: string): number {
  try {
    return compactDependencies.getModelManager().getModel('main', sessionId)?.contextLength ?? 128_000
  } catch {
    return 128_000
  }
}

/**
 * 从 assistant 消息的 usage 中提取输入 token 数
 * 支持 Anthropic 和 OpenAI 两种格式
 */
function getInputTokensFromUsage(usage: any): number {
  if (!usage || typeof usage !== 'object') {
    return 0
  }
  if ('input_tokens' in usage) {
    // Anthropic 格式
    return usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0)
  } else if ('prompt_tokens' in usage) {
    // OpenAI 格式
    return usage.prompt_tokens
  }
  return 0
}

/**
 * 简单消息截断策略
 * 当压缩失败时使用此备用策略，保留最近的消息直到达到目标token数
 *
 * 实现原理：
 * - 每个 assistant 消息的 usage.input_tokens 是累计值，表示到该位置为止的总输入 token
 * - 通过正序遍历找到累计 token 超过需要移除量的位置，从该位置之后保留消息
 */
function truncateMessages(messages: Message[], targetTokenLimit: number): Message[] {
  if (messages.length <= 2) {
    return messages
  }

  // 获取总 token 数（从最后一个 assistant 消息的 usage 获取）
  const totalTokens = countTokens(messages)
  const totalInputTokens = totalTokens.inputTokens

  // 如果总 token 数已经在限制内，无需截断
  if (totalInputTokens <= targetTokenLimit) {
    return messages
  }

  // 需要移除的 token 数
  const tokensToRemove = totalInputTokens - targetTokenLimit

  logDebug(`[Compact] Truncating: total=${totalInputTokens}, target=${targetTokenLimit}, toRemove=${tokensToRemove}`)

  // 正序遍历，找到累计 token 超过 tokensToRemove 的 assistant 消息
  // 每个 assistant 消息的 input_tokens 是到该位置的累计输入 token
  // 当累计 token >= tokensToRemove 时，说明从该位置之后的消息在目标限制内
  let cutIndex = 0

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]

    if (message.type === 'assistant' && 'usage' in message.message) {
      const inputTokens = getInputTokensFromUsage(message.message.usage)

      if (inputTokens >= tokensToRemove) {
        // 从这条 assistant 开始保留：它的 tool_use 与下一条 user 消息里的 tool_result 配对，
        // 若从 i + 1 开始会留下孤儿 tool_result，API 会拒绝
        cutIndex = i
        break
      }
    }
  }

  // 如果没找到合适的切割点，保留最后的用户-助手消息对
  if (cutIndex === 0 || cutIndex >= messages.length) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user') {
        cutIndex = i
        break
      }
    }
    cutIndex = Math.max(0, cutIndex)
  }

  const result = messages.slice(cutIndex)

  // 确保至少保留一条消息
  if (result.length === 0 && messages.length > 0) {
    result.push(messages[messages.length - 1])
  }

  // 在开头添加截断提示消息
  if (result.length < messages.length) {
    const truncatedMessage = buildUserMsg(
      `${CONTEXT_TRUNCATED_NOTICE_LEAD} ${messages.length - result.length} earlier messages removed. Recent conversation preserved.`
    )
    result.unshift(truncatedMessage)
  }

  logDebug(`[Compact] Truncation result: kept ${result.length} of ${messages.length} messages`)

  return result
}

/**
 * 计算压缩率
 */
function calculateCompactRate(tokenBefore: number, tokenAfter: number): number {
  return tokenAfter / tokenBefore;
}

function isInvalidCompactResponse(response: AiMessage): boolean {
  const usage = response.message.usage as any
  if (!usage || typeof usage !== 'object') return true

  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0

  if (response.message.stop_reason == null) return true
  if (inputTokens === 0 && outputTokens === 0) return true

  const content = response.message.content as any
  if (typeof content === 'string') return content.length === 0
  return !Array.isArray(content) || content.length === 0
}

function extractSummaryText(response: AiMessage): string {
  const content = response.message.content as any

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    const textBlock = content.find((block: any) => block.type === 'text')
    return textBlock?.type === 'text' ? textBlock.text : ''
  }

  return ''
}

function emitCompactUsage(
  messagesBefore: Message[],
  messagesAfter: Message[] | null,
  sessionId: string | undefined,
  mode: 'summary' | 'truncated' | 'failed',
  reason?: string,
  error?: unknown,
): void {
  try {
    // `compact:exec` means a compacted transcript was actually committed.
    // Failed compact attempts must not emit it, otherwise clients may hide the
    // visible transcript even though persisted history remains unchanged.
    if (mode === 'failed' || !messagesAfter) {
      return
    }

    const tokensBeforeInfo = countTokens(messagesBefore)
    const tokenBefore = tokensBeforeInfo.inputTokens + tokensBeforeInfo.outputTokens
    const usage = getTokens(messagesAfter, sessionId)
    const eventBus = compactDependencies.getEventBus()
    const compactExecData: CompactExecData = {
      tokenBefore,
      tokenCompact: usage.useTokens,
      compactRate: calculateCompactRate(tokenBefore, usage.useTokens),
      mode,
      reason,
      errMsg: error instanceof Error ? error.message : error ? String(error) : undefined,
    }

    eventBus.emit('compact:exec', compactExecData, sessionId)
    eventBus.emit('conversation:usage', { usage }, sessionId)
  } catch (usageError) {
    logError(`Failed to emit compact usage: ${usageError}`)
  }
}

/**
 * 估算当前上下文占用，口径为"即将发送的请求"：
 * 最近有效 usage 的 input（上次请求的上下文）+ 该次 output（本次响应已进入上下文）
 * + 该 assistant 之后新增消息（工具结果、新用户输入）的估算。
 * 只看 input 会滞后一轮，单轮新增多个大工具结果时可能撞限。
 * 没有任何有效 usage 时（如全是合成消息的历史）按全部消息估算。
 * 压缩判断与 compact:micro 事件统计共用此函数，保证口径一致。
 */
function estimateContextTokens(messages: Message[]): number {
  const { inputTokens, outputTokens, index } = countTokens(messages)
  return inputTokens + outputTokens + estimateMessagesTokens(messages.slice(index + 1))
}

/**
 * 根据令牌使用量判断是否应触发自动压缩（口径见 estimateContextTokens）
 *
 * @param discountTokens 估算折扣：usage 读的是上一次 API 响应，
 * micro 清理的节省要到下一次响应才可见，期间用该折扣修正判断。默认 0。
 * 传入的 messages 应是清理前的历史，否则 usage 下标之后被清理的块会在估算与折扣中重复扣减。
 */
export function needsAutoCompact(messages: Message[], discountTokens = 0, sessionId?: string): boolean {
  if (messages.length < 3) return false

  const autoCompactThreshold = getContextLimit(sessionId) * AUTO_COMPACT_THRESHOLD_RATIO
  return (estimateContextTokens(messages) - discountTokens) >= autoCompactThreshold
}

export type MicroCompactApplyResult = {
  messages: Message[]
  needFullCompact: boolean
  changed: boolean
  /** 清理统计（仅 changed=true 时存在），与 compact:micro 事件载荷完全一致 */
  stats?: CompactMicroData
}

/**
 * Micro 压缩集成入口（全量摘要前的第一道防线）
 *
 * 把模型已消费过的旧 tool_result 块替换为占位符（纯本地操作，不调模型），
 * 再用估算折扣判断清理后是否仍需全量摘要。清理无条件生效并随历史落盘，
 * 与后续摘要成败无关。有清理时发 compact:micro 事件（便于观测节省量）。
 *
 * 任何异常均退回旧行为（needFullCompact: true，消息原样返回）。
 */
export function applyMicroCompact(messages: Message[], sessionId?: string): MicroCompactApplyResult {
  try {
    const result = microCompactMessages(messages)
    if (!result.changed) {
      return { messages, needFullCompact: true, changed: false }
    }

    // 在清理前的 messages 上判断再减本次节省：清理后的消息里 usage 下标之后的块已是占位符，
    // 若在其上估算再减全部节省，这部分会被扣两次而低估占用
    const stillOver = needsAutoCompact(messages, result.estimatedSavedTokens, sessionId)

    // estimatedTokenAfter = 清理前的估算占用 − 估算节省，与 stillOver 的判断口径完全一致
    const tokenBefore = estimateContextTokens(messages)
    const microData: CompactMicroData = {
      clearedCount: result.clearedCount,
      estimatedSavedTokens: result.estimatedSavedTokens,
      estimatedTokenAfter: Math.max(0, tokenBefore - result.estimatedSavedTokens),
      skippedFullCompact: !stillOver,
    }

    // 独立事件：绝不复用 compact:exec（该事件语义是"历史已被摘要替换"，下游会隐藏 transcript）
    try {
      compactDependencies.getEventBus().emit('compact:micro', microData, sessionId)
    } catch (emitError) {
      logError(`[MicroCompact] Failed to emit compact:micro: ${emitError}`)
    }

    logDebug(
      `[MicroCompact] cleared=${microData.clearedCount} blocks, estimatedSaved=${microData.estimatedSavedTokens} tokens, estimatedTokenAfter=${microData.estimatedTokenAfter}, skippedFullCompact=${microData.skippedFullCompact}`
    )

    return { messages: result.messages, needFullCompact: stillOver, changed: true, stats: microData }
  } catch (error) {
    logError(`[MicroCompact] failed, falling back to full compact: ${error}`)
    return { messages, needFullCompact: true, changed: false }
  }
}


/**
 * 执行上下文压缩（公开接口）
 *
 * 该函数直接执行压缩，不检查阈值。适用于：
 * - 用户手动触发 /compact 命令
 * - 自动压缩检查通过后调用

 * 改进的错误处理机制：
 * - 压缩失败时会自动使用消息截断作为备用策略
 * - 确保系统在各种异常情况下都能保持功能正常
 * - 提供多层降级方案以避免完全失败
 */
export async function compactMessages(
  messages: Message[],
  abortController: AbortController,
  sessionId?: string,
  options: { allowTruncationFallback?: boolean; customInstructions?: string; emitUsageEvent?: boolean } = {}
): Promise<CompactResult> {
  const allowTruncationFallback = options.allowTruncationFallback ?? true
  // 自动压缩路径只压历史的一段，事件口径需按整段上下文计算，由 autoCompact 自行发出
  const emitUsageEvent = options.emitUsageEvent ?? true
  const emitUsage = (
    messagesAfter: Message[] | null,
    mode: 'summary' | 'truncated' | 'failed',
    reason?: string,
    error?: unknown,
  ) => {
    if (emitUsageEvent) emitCompactUsage(messages, messagesAfter, sessionId, mode, reason, error)
  }

  if (messages.length < 2) {
    return { kind: 'unchanged', messages }
  }

  try {
    const summaryResult = await executeAutoCompact(messages, abortController, sessionId, options.customInstructions)

    // 用户中断：适配层不抛错而是返回部分内容，不能当成摘要，也不能进有损的截断兜底
    if (abortController.signal.aborted) {
      logInfo('[Compact] Aborted by user, keeping messages unchanged')
      return { kind: 'unchanged', messages }
    }

    if (summaryResult.kind === 'summary') {
      emitUsage(summaryResult.messages, 'summary')
      return summaryResult
    }

    if (!allowTruncationFallback) {
      emitUsage(null, 'failed', summaryResult.reason)
      return {
        kind: 'failed',
        error: new Error(`Compact did not produce a valid summary: ${summaryResult.reason}`),
      }
    }

    const contextLimit = getContextLimit(sessionId)
    const targetLimit = contextLimit * 0.5 // 截断到50%容量
    const truncatedMessages = truncateMessages(messages, targetLimit)
    emitUsage(truncatedMessages, 'truncated', summaryResult.reason)

    return {
      kind: 'truncated',
      messages: truncatedMessages,
      reason: summaryResult.reason,
    }
  } catch (error) {
    // 用户中断（SDK 层抛出中断异常的路径）：同上，直接退出不降级
    if (abortController.signal.aborted) {
      logInfo('[Compact] Aborted by user, keeping messages unchanged')
      return { kind: 'unchanged', messages }
    }

    if (!allowTruncationFallback) {
      emitUsage(null, 'failed', 'COMPACT_ERROR', error)
      return {
        kind: 'failed',
        error,
      }
    }

    // 压缩完全失败时的备用策略：使用截断方式
    logError(`Compact failed, attempting truncation fallback: ${error}`)

    try {
      const contextLimit = getContextLimit(sessionId)
      const targetLimit = contextLimit * 0.5 // 截断到50%容量

      const truncatedMessages = truncateMessages(messages, targetLimit)

      logError(`Successfully applied truncation fallback, reduced from ${messages.length} to ${truncatedMessages.length} messages`)
      emitUsage(truncatedMessages, 'truncated', 'COMPACT_ERROR', error)

      return {
        kind: 'truncated',
        messages: truncatedMessages,
        reason: 'COMPACT_ERROR',
      }
    } catch (truncationError) {
      // 如果连截断都失败，返回失败结果
      logError(`Truncation fallback also failed: ${truncationError}`)
      emitUsage(null, 'failed', 'COMPACT_ERROR', truncationError)

      return {
        kind: 'failed',
        error: truncationError,
      }
    }
  }
}

export type RecoveredSkillActivation = {
  name: string
  text: string
  /** 激活所在 user 消息的 uuid，用于截断兜底后判断该消息是否幸存 */
  uuid: string
}

/**
 * 扫描消息列表中 skill 工具的成功激活：tool_use(skill) 配对非报错 tool_result，
 * 且同消息内有当时注入的 skill 全文 text 块。同名多次调用取最后一次。
 * 全文从历史原样取：天然证明激活成功、参数已替换、与模型当时所见一致
 * （microCompact 只清 tool_result 不碰 text 块，该块必然还在）。
 */
export function collectSkillActivations(messages: Message[]): RecoveredSkillActivation[] {
  // tool_use_id -> skill 名
  const toolUseNames = new Map<string, string>()
  for (const msg of messages) {
    if (msg.type !== 'assistant' || !Array.isArray(msg.message.content)) continue
    for (const block of msg.message.content) {
      if (block.type === 'tool_use' && block.name === TOOL_NAME_SKILL) {
        const skillName = (block.input as { skill?: string } | undefined)?.skill
        if (skillName) toolUseNames.set(block.id, skillName)
      }
    }
  }

  const byName = new Map<string, RecoveredSkillActivation>()
  for (const msg of messages) {
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue
    const content = msg.message.content as Anthropic.ContentBlockParam[]
    for (let i = 0; i < content.length; i++) {
      const block = content[i]

      // 上一次压缩注入的 skill 原文块：解析后接力，保证 skill 上下文可跨多次压缩存续；
      // 同名后续真实激活按消息序覆盖接力内容
      if (block.type === 'text' && block.text.startsWith(`${REMINDER_SYS_OPEN}\n${SKILL_CONTEXT_NOTICE}`)) {
        for (const activation of parseSkillContextBlock(block.text, msg.uuid)) {
          byName.set(activation.name, activation)
        }
        continue
      }

      if (block.type !== 'tool_result') continue
      const name = toolUseNames.get(block.tool_use_id)
      if (!name || block.is_error === true) continue
      // skill 全文（additionalBlocks）紧随 tool_result 之后；
      // 跳过 reminder-sys 开头的块（注入的用户消息、hook 上下文等非 skill 正文）
      for (let j = i + 1; j < content.length; j++) {
        const next = content[j]
        if (next.type === 'tool_result') break
        if (next.type === 'text' && !next.text.startsWith(REMINDER_SYS_OPEN)) {
          byName.set(name, { name, text: next.text, uuid: msg.uuid })
          break
        }
      }
    }
  }
  return [...byName.values()]
}

/**
 * 解析压缩后注入的 skill 原文块（格式见 generatePostCompactReminders 的 sections 拼装），
 * 还原为激活列表。skill 正文若恰好含 "### Skill: " 行会造成误切分，风险极低且
 * 伪名称会被后续的存在性过滤剔除。
 */
function parseSkillContextBlock(text: string, uuid: string): RecoveredSkillActivation[] {
  let body = text
  if (body.startsWith(REMINDER_SYS_OPEN)) body = body.slice(REMINDER_SYS_OPEN.length)
  if (body.endsWith(REMINDER_SYS_CLOSE)) body = body.slice(0, -REMINDER_SYS_CLOSE.length)

  return body.split(/^### Skill: /m).slice(1).map(section => {
    const newlineIdx = section.indexOf('\n')
    const name = (newlineIdx === -1 ? section : section.slice(0, newlineIdx)).trim()
    const skillText = (newlineIdx === -1 ? '' : section.slice(newlineIdx + 1)).trim()
    return { name, text: skillText, uuid }
  }).filter(a => a.name && a.text)
}

/**
 * 把 reminder 块插入首条 user 消息（压缩通知/截断通知）的通知文本之前：
 * 阅读序为 [reminders..., 通知文本, 摘要(assistant)]，通知文本紧邻其引出的摘要。
 * 首条消息非 user 时原样返回（截断兜底未删任何消息的罕见场景），不做强行注入。
 */
function prependBlocksToLeadingUserMsg(
  messages: Message[],
  blocks: Anthropic.ContentBlockParam[],
): Message[] {
  const first = messages[0]
  if (!first || first.type !== 'user') {
    return messages
  }

  const content = first.message.content
  const contentBlocks: Anthropic.ContentBlockParam[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : [...content]

  const nextFirst: Message = {
    ...first,
    message: { ...first.message, content: [...blocks, ...contentBlocks] },
  }
  return [nextFirst, ...messages.slice(1)]
}

/**
 * 按文本长度估算一组消息的 token 数（口径与 microcompact 一致）。
 * 用于 compact:exec 事件里被压区与新前缀的差值计算，以及 needsAutoCompact 对
 * 最近 usage 之后新增消息的估算。
 */
function estimateMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    const content = msg.message.content
    if (typeof content === 'string') {
      total += estimateTokensFromText(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as any[]) {
      switch (block?.type) {
        case 'text':
          total += estimateTokensFromText(block.text ?? '')
          break
        case 'thinking':
          total += estimateTokensFromText(block.thinking ?? '')
          break
        case 'tool_use':
          total += estimateTokensFromText(JSON.stringify(block.input ?? {}))
          break
        case 'tool_result': {
          const inner = block.content
          if (typeof inner === 'string') {
            total += estimateTokensFromText(inner)
          } else if (Array.isArray(inner)) {
            for (const part of inner) {
              if (part?.type === 'text') total += estimateTokensFromText(part.text ?? '')
              else if (part?.type === 'image') total += IMAGE_BLOCK_TOKEN_ESTIMATE
            }
          }
          break
        }
        case 'image':
          total += IMAGE_BLOCK_TOKEN_ESTIMATE
          break
      }
    }
  }
  return total
}

/**
 * 计算自动压缩的切点：messages.slice(0, cutIdx) 为被压区，其余为保留区。
 *
 * 切点只落在两类位置，二者都保证 tool_use/tool_result 不被拆散，
 * 也保证 skill 激活的 tool_use 与其 tool_result/全文块在同一侧（collectSkillActivations 按区域配对）：
 * - 某个工具轮次的 assistant 消息：保留最后一条 assistant 起的未消费尾部，
 *   再往前保留 COMPACT_KEEP_RECENT_TOOL_ROUNDS 个已消费轮次，切在最老一个保留轮次的 assistant 上；
 * - 最后一条真实用户消息：它落在保留窗口内或紧贴切点时（本轮很短、或最新消息就是新查询），
 *   切到它，用户原话原样保留，等价于旧行为。
 *
 * 旧行为整轮豁免：agent 单轮跑几十次工具时可压区几乎为空，再触发只能对上一份摘要复摘，
 * 摘要越压越大而真实上下文单调增长。
 */
function findCompactCut(messages: Message[]): { cutIdx: number; lastRealUserIdx: number } {
  // 从后往前找最后一条真实用户消息（首块非 tool_result）
  let lastRealUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type !== 'user') continue
    const content = messages[i].message.content
    const isToolResult = Array.isArray(content) &&
      content.length > 0 &&
      content[0]?.type === 'tool_result'
    if (!isToolResult) {
      lastRealUserIdx = i
      break
    }
  }
  if (lastRealUserIdx === -1) {
    return { cutIdx: 0, lastRealUserIdx }
  }

  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }

  // 未消费尾部（最后一条 assistant 起）无条件保留，再往前数 N 个 assistant 轮次
  let cutIdx = lastAssistantIdx
  if (lastAssistantIdx > 0) {
    let rounds = 0
    for (let i = lastAssistantIdx - 1; i >= 0 && rounds < COMPACT_KEEP_RECENT_TOOL_ROUNDS; i--) {
      if (messages[i].type === 'assistant') {
        rounds++
        cutIdx = i
      }
    }
  }

  // 没有 assistant，或最后一条真实用户消息落在保留窗口内/紧贴切点：切到用户消息
  if (lastAssistantIdx === -1 || lastRealUserIdx >= cutIdx - 1) {
    cutIdx = lastRealUserIdx
  }

  return { cutIdx, lastRealUserIdx }
}

// 回注用户指令原文的上限：超长粘贴不应抵消压缩收益
const MAX_VERBATIM_INSTRUCTION_CHARS = 4000

/**
 * 系统合成的 user 文本块，不是用户原话，不得当作指令回注：
 * reminder-sys 注入、压缩摘要、截断通知、中断标记
 */
function isSyntheticUserText(text: string): boolean {
  return text.startsWith(REMINDER_SYS_OPEN) ||
    text.startsWith(COMPACT_SUMMARY_LEAD) ||
    text.startsWith(CONTEXT_TRUNCATED_NOTICE_LEAD) ||
    text.trim() === REQ_INTERRUPT_MSG
}

/**
 * 提取真实用户消息的正文（跳过系统合成块与非文本块），用于压缩后原样回注。
 * 被压区开头若是上一次压缩的前缀消息，其中回注过的指令块（LATEST_USER_INSTRUCTION_NOTICE 起始）
 * 原样接力，保证用户指令可跨多次压缩存续；摘要块本身跳过，避免摘要被当作指令滚雪球。
 */
function extractUserInstructionText(msg: Message): string {
  const content = msg.message.content
  let text = ''
  if (typeof content === 'string') {
    text = isSyntheticUserText(content) ? '' : content.trim()
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content as Anthropic.ContentBlockParam[]) {
      if (block.type !== 'text') continue
      if (block.text.startsWith(LATEST_USER_INSTRUCTION_NOTICE)) {
        // 上一次压缩回注的指令块：直接接力，不再拼接其他块
        return block.text.slice(LATEST_USER_INSTRUCTION_NOTICE.length).trim()
      }
      if (isSyntheticUserText(block.text)) continue
      const trimmed = block.text.trim()
      if (trimmed) parts.push(trimmed)
    }
    text = parts.join('\n\n')
  }
  if (text.length > MAX_VERBATIM_INSTRUCTION_CHARS) {
    text = `${text.slice(0, MAX_VERBATIM_INSTRUCTION_CHARS)}\n[... truncated]`
  }
  return text
}

/**
 * 自动压缩路径的 compact:exec / conversation:usage 事件。
 * 被压区只是整段上下文的一段，事件按整段口径计算：
 * tokenBefore = 触发时的整段占用（含 system prompt 与工具定义，取自上次 API 响应的 usage），
 * tokenCompact = tokenBefore − 被压区估算 + 新前缀估算。
 */
function emitAutoCompactUsage(
  tokenBefore: number,
  messagesToCompact: Message[],
  compactedMessages: Message[],
  sessionId: string | undefined,
  mode: 'summary' | 'truncated',
  reason?: string,
): void {
  try {
    const removed = estimateMessagesTokens(messagesToCompact)
    const added = estimateMessagesTokens(compactedMessages)
    const tokenCompact = Math.max(0, tokenBefore - removed + added)
    if (added >= removed) {
      logWarn(`[Compact] Compacted prefix (~${added} tokens) is not smaller than the compacted range (~${removed} tokens)`)
    }
    logDebug(`[Compact] Usage: before=${tokenBefore}, removed≈${removed}, added≈${added}, after≈${tokenCompact}`)

    const compactExecData: CompactExecData = {
      tokenBefore,
      tokenCompact,
      compactRate: tokenBefore > 0 ? calculateCompactRate(tokenBefore, tokenCompact) : 0,
      mode,
      reason,
    }
    const eventBus = compactDependencies.getEventBus()
    eventBus.emit('compact:exec', compactExecData, sessionId)
    eventBus.emit('conversation:usage', {
      usage: { useTokens: tokenCompact, maxTokens: getContextLimit(sessionId), promptTokens: tokenCompact },
    }, sessionId)
  } catch (usageError) {
    logError(`Failed to emit auto compact usage: ${usageError}`)
  }
}

/**
 * 自动上下文压缩的主要入口函数
 *
 * 该函数在每次查询前被调用，用于检查对话是否已超出容量需要压缩。
 * 切点由 findCompactCut 决定：保留最近几个工具轮次与未消费尾部，其余历史（含本轮更早的工具轮次）
 * 交给摘要。这样可以保证：
 * 1. tool_use / tool_result 的配对关系不被破坏（切点只落在轮次边界的 assistant 或真实用户消息上）
 * 2. 压缩后前缀是单条 user 消息（与手动 /compact 同形），保留区无论以 user 还是 assistant 开头，
 *    角色交替都合法（连续 user 由 prepareMessagesForApi 合并）
 * 3. 最后一条真实用户消息被压进摘要时，原文回注，模型不丢失用户措辞
 *
 * 执行自动压缩（调用前应先通过 needsAutoCompact 判断是否需要压缩）
 */
export async function autoCompact(
  messages: Message[],
  abortController: AbortController,
  sessionId?: string,
  options: { hasSkillTool?: boolean } = {}
): Promise<AutoCompactResult> {
  const { cutIdx, lastRealUserIdx } = findCompactCut(messages)

  if (lastRealUserIdx === -1) {
    // 没有找到真实用户消息，跳过压缩
    return { changed: false, messages }
  }

  const messagesToCompact = messages.slice(0, cutIdx)
  const messagesToKeep = messages.slice(cutIdx)

  if (messagesToCompact.length < 2) {
    // 历史消息太少，不值得压缩
    return { changed: false, messages }
  }

  // 最后一条真实用户消息落入被压区（长工具轮次场景）：压缩后原样回注
  const compactedUserMsg = lastRealUserIdx < cutIdx ? messages[lastRealUserIdx] : null

  // 收集将被压掉的 skill 激活；保留区仍有同名激活的不补（原文还在）
  let compactedSkills = collectSkillActivations(messagesToCompact)
  if (compactedSkills.length > 0) {
    const keptNames = new Set(collectSkillActivations(messagesToKeep).map(a => a.name))
    compactedSkills = compactedSkills.filter(a => !keptNames.has(a.name))
  }

  logDebug(
    `[Compact] Cut at ${cutIdx}/${messages.length} (lastRealUser=${lastRealUserIdx}, userMsgCompacted=${compactedUserMsg !== null}), ` +
    `skills to re-inject: [${compactedSkills.map(a => a.name).join(', ')}]`
  )

  // 触发时的整段上下文占用（上次 API 响应的 usage，含本次响应输出），作为事件基准
  const tokensBefore = countTokens(messages)
  const tokenBefore = tokensBefore.inputTokens + tokensBefore.outputTokens

  const compactResult = await compactMessages(messagesToCompact, abortController, sessionId, { emitUsageEvent: false })

  if (compactResult.kind === 'summary' || compactResult.kind === 'truncated') {
    // 截断兜底会保留部分历史：激活消息 / 用户消息幸存的不补注，避免重复
    let userMsgSurvived = false
    if (compactResult.kind === 'truncated') {
      const survivedUuids = new Set<string>(compactResult.messages.map(m => m.uuid))
      compactedSkills = compactedSkills.filter(a => !survivedUuids.has(a.uuid))
      userMsgSurvived = compactedUserMsg !== null && survivedUuids.has(compactedUserMsg.uuid)
    }

    // 压缩后重新注入被压掉的 skill 原文与 skills/rules reminder（原注入随历史被摘要替换而丢失）
    const reminders = await generatePostCompactReminders(options.hasSkillTool ?? false, compactedSkills)

    const instruction = compactedUserMsg && !userMsgSurvived ? extractUserInstructionText(compactedUserMsg) : ''
    const instructionBlocks: Anthropic.ContentBlockParam[] = instruction
      ? [{ type: 'text', text: `${LATEST_USER_INSTRUCTION_NOTICE}\n\n${instruction}` }]
      : []

    let compactedMessages: Message[]
    if (compactResult.kind === 'summary') {
      // 单条 user 前缀：[reminders..., 包装后的摘要, 用户指令原文]
      compactedMessages = [buildUserMsg([
        ...reminders,
        { type: 'text', text: wrapCompactSummary(compactResult.summary) },
        ...instructionBlocks,
      ])]
    } else {
      // 截断兜底：前置拼进首条截断通知 user 消息，不新增消息
      const extraBlocks = [...reminders, ...instructionBlocks]
      compactedMessages = extraBlocks.length > 0
        ? prependBlocksToLeadingUserMsg(compactResult.messages, extraBlocks)
        : compactResult.messages
    }

    // 组合结果示例（长工具轮次场景）：
    //   [prefix(user), assistant(tool_use), toolResult(user), ..., assistant(tool_use), toolResult(user)]
    // 组合结果示例（短轮次 / 新查询场景）：
    //   [prefix(user), lastRealUserMsg(user), ...]  → 连续 user 由 prepareMessagesForApi 合并
    const finalMessages = [...compactedMessages, ...messagesToKeep]

    logDebug(`[Compact] Final messages count: ${finalMessages.length}, kept: ${messagesToKeep.length} messages`)

    emitAutoCompactUsage(
      tokenBefore,
      messagesToCompact,
      compactedMessages,
      sessionId,
      compactResult.kind,
      compactResult.kind === 'truncated' ? compactResult.reason : undefined,
    )

    return {
      changed: true,
      messages: finalMessages,
      mode: compactResult.kind,
    }
  }

  if (compactResult.kind === 'unchanged') {
    return { changed: false, messages }
  }

  logError(`Auto-compact failed completely: ${compactResult.error}. Continuing with original messages`)
  return { changed: false, messages, error: compactResult.error }
}

/**
 * Null Tool - 用于占位避免工具调用
 * 在某些场景下（如压缩），模型必须提供 tools 参数，但我们不希望模型调用任何工具
 * 此工具作为占位符，确保 API 调用合法但不会被实际使用
 */
export const NULL_TOOL: Tool = {
  name: 'null',
  description: '占位工具，不应被调用。仅用于满足 API 要求，实际场景中请勿使用此工具。',
  toolParams: z.object({}),
  isSafe: () => true,
  genResultForAssistant: () => '',
  call: async function* () {
    yield { type: 'result' as const, data: null }
  }
}

/**
 * 使用主模型执行对话压缩处理流程
 *
 * 该函数通过主模型生成全面摘要——主模型更适合处理复杂的摘要任务。
 *
 * 压缩逻辑：
 * 1. 压缩传入的历史对话消息
 * 2. 返回结构：[压缩指令(user), 压缩摘要(assistant+usage)]
 *
 * 注意：新用户消息的分离和添加由 autoCompact 统一处理
 */
async function executeAutoCompact(
  messages: Message[],
  abortController: AbortController,
  sessionId?: string,
  customInstructions?: string
): Promise<CompactSummaryResult> {
  // 使用 null tool 作为占位，避免模型调用任何工具
  const tools = [NULL_TOOL]

  // 将压缩指令作为 user message 追加到要压缩的历史对话后，再统一规范化：
  // 被压区可能以 user(tool_result) 结尾（自动压缩切在轮次边界），规范化会把连续 user 合并
  // 无自定义指示时 buildCompressionPrompt 返回 COMPRESSION_PROMPT 原文
  const messagesWithPrompt = prepareMessagesForApi([
    ...messages,
    buildUserMsg(buildCompressionPrompt(customInstructions))
  ])

  const summaryResponse = await compactDependencies.queryLLM(
    messagesWithPrompt,
    [
      {
        type: 'text',
        text: 'An AI assistant that helps summarize coding conversations.'
      }
    ],
    abortController.signal,
    tools,
    // sessionId 透传：压缩的 LLM 调用日志按会话拆分（llm_logs/日期_会话id.log）
    { modelPointer: 'main', disableChunkEvents: true, sessionId }
  )

  if (isInvalidCompactResponse(summaryResponse)) {
    return {
      kind: 'invalid',
      reason: 'INVALID_COMPACT_RESPONSE',
    }
  }

  const summary = extractSummaryText(summaryResponse)

  if (summary.trim().length === 0) {
    return {
      kind: 'invalid',
      reason: 'EMPTY_SUMMARY',
    }
  }

  // 压缩后的消息结构：
  // 1. User: 压缩通知
  // 2. Assistant: summaryResponse（压缩摘要 + 修正的 usage）
  //
  // 注意：新用户消息的添加由 checkAutoCompact 统一处理，这里不需要处理
  // 重要：summaryResponse 的 usage 包含了整个压缩过程的 token 数（历史对话 + 压缩指令）
  // 需要修正为压缩后消息的实际 token 数（压缩通知 + 摘要）
  const compactNoticeMessage = buildUserMsg(COMPACT_RESUME_NOTICE)

  // 修正 usage：压缩后的实际 token 数应该是压缩通知 + 摘要内容
  // 估算：压缩通知约 30 tokens，摘要使用 completion_tokens。
  // countTokens 把 input + output 作为"该点的上下文占用"，摘要只计入 input，output 置 0 避免双计
  const originalUsage = summaryResponse.message.usage as any
  const estimatedNoticeTokens = 30
  const summaryTokens = originalUsage.completion_tokens || originalUsage.output_tokens || 0
  const correctedInputTokens = estimatedNoticeTokens + summaryTokens
  const originalInputTokens = originalUsage.input_tokens ?? originalUsage.prompt_tokens ?? 0
  const originalOutputTokens = originalUsage.output_tokens ?? originalUsage.completion_tokens ?? 0

  // 创建修正后的 summary message
  const correctedSummaryMessage: typeof summaryResponse = {
    ...summaryResponse,
    message: {
      ...summaryResponse.message,
      usage: {
        ...originalUsage,
        // 修正 input_tokens：压缩通知 + 摘要内容
        input_tokens: correctedInputTokens,
        output_tokens: 0,
        // 如果是 OpenAI 格式，也要修正
        prompt_tokens: correctedInputTokens,
        completion_tokens: 0,
      }
    }
  }

  logDebug(
    `[Compact] Corrected summary usage: originalInput=${originalInputTokens}, originalOutput=${originalOutputTokens}, correctedInput=${correctedInputTokens}, correctedOutput=0`
  )

  // 构建压缩后的消息列表（只包含压缩通知和摘要，不包含新用户消息）
  const compactedMessages: Message[] = [compactNoticeMessage, correctedSummaryMessage]

  return {
    kind: 'summary',
    messages: compactedMessages,
    summary,
  }
}

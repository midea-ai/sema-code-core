import type Anthropic from '@anthropic-ai/sdk'
import { AiMessage, Message } from '../types/message'
import { countTokens } from './tokens'
import { buildUserMsg, prepareMessagesForApi } from './message'
import { queryLLM } from '../services/api/queryLLM'
import { getModelManager } from '../manager/ModelManager'
import { logDebug, logError } from './log'
import { getEventBus } from '../events/EventSystem'
import { CompactExecData, CompactMicroData } from '../events/types'
import { microCompactMessages } from './microcompact'
import { Tool } from '../tools/base/Tool'
import { z } from 'zod'
import { getTokens } from './tokens'
import { buildCompressionPrompt, SKILL_CONTEXT_NOTICE, COMPACT_RESUME_NOTICE } from '../prompt/compact'
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
        // 从下一条消息开始保留
        cutIndex = i + 1
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
      `Context truncated due to token limit. ${messages.length - result.length} earlier messages removed. Recent conversation preserved.`
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
 * 根据令牌使用量判断是否应触发自动压缩
 * 只计算输入token数，因为API调用时主要关心的是输入token限制
 *
 * @param discountTokens 估算折扣：countTokens 读的是上一次 API 响应的 usage，
 * micro 清理的节省要到下一次响应才可见，期间用该折扣修正判断。默认 0，行为与原先一致。
 */
export function needsAutoCompact(messages: Message[], discountTokens = 0, sessionId?: string): boolean {
  if (messages.length < 3) return false

  const inputTokenCount = countTokens(messages).inputTokens
  const autoCompactThreshold = getContextLimit(sessionId) * AUTO_COMPACT_THRESHOLD_RATIO

  return (inputTokenCount - discountTokens) >= autoCompactThreshold
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

    const stillOver = needsAutoCompact(result.messages, result.estimatedSavedTokens, sessionId)

    // estimatedTokenAfter = 上次 API 响应的真实 usage − 估算节省，与"要不要全量摘要"的判断口径一致；
    // 清理前的值不重复携带（= 紧邻上一条 conversation:usage 的 promptTokens）
    const tokenBefore = countTokens(result.messages).inputTokens
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
  options: { allowTruncationFallback?: boolean; customInstructions?: string } = {}
): Promise<CompactResult> {
  const allowTruncationFallback = options.allowTruncationFallback ?? true

  if (messages.length < 2) {
    return { kind: 'unchanged', messages }
  }

  try {
    const summaryResult = await executeAutoCompact(messages, abortController, sessionId, options.customInstructions)

    if (summaryResult.kind === 'summary') {
      emitCompactUsage(messages, summaryResult.messages, sessionId, 'summary')
      return summaryResult
    }

    if (!allowTruncationFallback) {
      emitCompactUsage(messages, null, sessionId, 'failed', summaryResult.reason)
      return {
        kind: 'failed',
        error: new Error(`Compact did not produce a valid summary: ${summaryResult.reason}`),
      }
    }

    const contextLimit = getContextLimit(sessionId)
    const targetLimit = contextLimit * 0.5 // 截断到50%容量
    const truncatedMessages = truncateMessages(messages, targetLimit)
    emitCompactUsage(messages, truncatedMessages, sessionId, 'truncated', summaryResult.reason)

    return {
      kind: 'truncated',
      messages: truncatedMessages,
      reason: summaryResult.reason,
    }
  } catch (error) {
    if (!allowTruncationFallback) {
      emitCompactUsage(messages, null, sessionId, 'failed', 'COMPACT_ERROR', error)
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
      emitCompactUsage(messages, truncatedMessages, sessionId, 'truncated', 'COMPACT_ERROR', error)

      return {
        kind: 'truncated',
        messages: truncatedMessages,
        reason: 'COMPACT_ERROR',
      }
    } catch (truncationError) {
      // 如果连截断都失败，返回失败结果
      logError(`Truncation fallback also failed: ${truncationError}`)
      emitCompactUsage(messages, null, sessionId, 'failed', 'COMPACT_ERROR', truncationError)

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
 * 自动上下文压缩的主要入口函数
 *
 * 该函数在每次查询前被调用，用于检查对话是否已超出容量需要压缩。
 * 找到最后一条真实用户消息（非 tool_result），只压缩它之前的历史，
 * 保留"当前对话轮次"（lastRealUserMsg + assistantMsg + toolResults）不动。
 * 这样可以保证：
 * 1. 压缩后的消息列表以用户消息结尾，LLM 调用不会失败
 * 2. tool_use / tool_result 的配对关系不被破坏
 *
 * 执行自动压缩（调用前应先通过 needsAutoCompact 判断是否需要压缩）
 */
export async function autoCompact(
  messages: Message[],
  abortController: AbortController,
  sessionId?: string,
  options: { hasSkillTool?: boolean } = {}
): Promise<AutoCompactResult> {
  // 从后往前找最后一条真实用户消息（非 tool_result）的索引
  let lastRealUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'user') {
      const content = messages[i].message.content
      const isToolResult = Array.isArray(content) &&
        content.length > 0 &&
        content[0]?.type === 'tool_result'
      if (!isToolResult) {
        lastRealUserIdx = i
        break
      }
    }
  }

  if (lastRealUserIdx === -1) {
    // 没有找到真实用户消息，跳过压缩
    return { changed: false, messages }
  }

  // 只压缩最后一条真实用户消息之前的历史
  const messagesToCompact = messages.slice(0, lastRealUserIdx)
  // 保留当前对话轮次（最后一条真实用户消息及之后的所有内容）
  const messagesToKeep = messages.slice(lastRealUserIdx)

  if (messagesToCompact.length < 2) {
    // 历史消息太少，不值得压缩
    return { changed: false, messages }
  }

  // 收集将被压掉的 skill 激活；保留区仍有同名激活的不补（原文还在）
  let compactedSkills = collectSkillActivations(messagesToCompact)
  if (compactedSkills.length > 0) {
    const keptNames = new Set(collectSkillActivations(messagesToKeep).map(a => a.name))
    compactedSkills = compactedSkills.filter(a => !keptNames.has(a.name))
  }

  const compactResult = await compactMessages(messagesToCompact, abortController, sessionId)

  if (compactResult.kind === 'summary' || compactResult.kind === 'truncated') {
    // 截断兜底会保留部分历史：激活消息幸存的不补注，避免重复
    if (compactResult.kind === 'truncated' && compactedSkills.length > 0) {
      const survivedUuids = new Set<string>(compactResult.messages.map(m => m.uuid))
      compactedSkills = compactedSkills.filter(a => !survivedUuids.has(a.uuid))
    }

    // 压缩后重新注入被压掉的 skill 原文与 skills/rules reminder（原注入随历史被摘要替换而丢失），
    // 前置拼进首条通知 user 消息，不新增消息以避免连续 user 消息的顺序问题
    const reminders = await generatePostCompactReminders(options.hasSkillTool ?? false, compactedSkills)
    const compactedMessages = reminders.length > 0
      ? prependBlocksToLeadingUserMsg(compactResult.messages, reminders)
      : compactResult.messages

    // 组合结果示例（工具调用场景）：
    //   [compactNotice(user), summaryMsg(assistant), lastRealUserMsg(user), assistantMsg(assistant), toolResult(user)]
    // 组合结果示例（新查询场景）：
    //   [compactNotice(user), summaryMsg(assistant), newUserQuery(user)]
    // 两种场景均以 user 消息结尾，API 调用合法
    const finalMessages = [...compactedMessages, ...messagesToKeep]

    logDebug(`[Compact] Final messages count: ${finalMessages.length}, kept current turn: ${messagesToKeep.length} messages`)

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

  // 将压缩指令作为 user message 追加到要压缩的历史对话后
  // 无自定义指示时 buildCompressionPrompt 返回 COMPRESSION_PROMPT 原文，自动压缩路径行为不变
  const messagesWithPrompt = [
    ...prepareMessagesForApi([...messages]),
    buildUserMsg(buildCompressionPrompt(customInstructions))
  ]

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
  // 估算：压缩通知约 30 tokens，摘要使用 completion_tokens
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
        // 修正 output_tokens：摘要内容
        output_tokens: summaryTokens,
        // 如果是 OpenAI 格式，也要修正
        prompt_tokens: correctedInputTokens,
        completion_tokens: summaryTokens,
      }
    }
  }

  logDebug(
    `[Compact] Corrected summary usage: originalInput=${originalInputTokens}, originalOutput=${originalOutputTokens}, correctedInput=${correctedInputTokens}, correctedOutput=${summaryTokens}`
  )

  // 构建压缩后的消息列表（只包含压缩通知和摘要，不包含新用户消息）
  const compactedMessages: Message[] = [compactNoticeMessage, correctedSummaryMessage]

  return {
    kind: 'summary',
    messages: compactedMessages,
    summary,
  }
}

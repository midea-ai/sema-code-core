import { Message } from '../types/message'
import { countTokens } from './tokens'
import { buildUserMsg, prepareMessagesForApi } from './message'
import { queryLLM } from '../services/api/queryLLM'
import { getModelManager } from '../manager/ModelManager'
import { logDebug, logError } from './log'
import { getEventBus } from '../events/EventSystem'
import { CompactExecData } from '../events/types'
import { Tool } from '../tools/base/Tool'
import { z } from 'zod'
import { getTokens } from './tokens'
import { COMPRESSION_PROMPT } from '../prompt/compact'


/**
 * 触发自动上下文压缩的阈值比例
 * 当上下文使用量超过模型限制的75%时，将自动激活紧凑化处理
 * 提前触发压缩以避免接近token限制时的API调用失败
 */
const AUTO_COMPACT_THRESHOLD_RATIO = 0.75

function getContextLimit(): number {
  try {
    return getModelManager().getModel('main')?.contextLength ?? 128_000
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

/**
 * 基于主模型能力计算上下文使用阈值
 * 采用主模型上下文长度作为基准，因为压缩任务需要由性能足够的模型处理
 */
/**
 * 根据令牌使用量判断是否应触发自动压缩
 * 只计算输入token数，因为API调用时主要关心的是输入token限制
 */
export function needsAutoCompact(messages: Message[]): boolean {
  if (messages.length < 3) return false

  const inputTokenCount = countTokens(messages).inputTokens
  const autoCompactThreshold = getContextLimit() * AUTO_COMPACT_THRESHOLD_RATIO

  return inputTokenCount >= autoCompactThreshold
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
  abortController: AbortController
): Promise<Message[]> {
  if (messages.length < 2) {
    return messages
  }

  // 计算压缩前的输入token数
  const tokensBeforeInfo = countTokens(messages);
  const tokenBefore = tokensBeforeInfo.inputTokens + tokensBeforeInfo.outputTokens;

  let compactedMessages

  try {
    compactedMessages = await executeAutoCompact(messages, abortController)
  } catch (error) {
    // 压缩完全失败时的备用策略：使用截断方式
    logError(`Compact failed, attempting truncation fallback: ${error}`)

    try {
      const contextLimit = getContextLimit()
      const targetLimit = contextLimit * 0.5 // 截断到50%容量

      compactedMessages = truncateMessages(messages, targetLimit)

      logError(`Successfully applied truncation fallback, reduced from ${messages.length} to ${compactedMessages.length} messages`)

    } catch (truncationError) {
      // 如果连截断都失败，抛出错误
      logError(`Truncation fallback also failed: ${truncationError}`)
      throw truncationError
    }
  }
  // 计算压缩后的输入token数并触发事件
  const usage = getTokens(compactedMessages);

  // 触发压缩执行事件
  const eventBus = getEventBus();
  const compactExecData: CompactExecData = {
    tokenBefore: tokenBefore,
    tokenCompact: usage.useTokens,
    compactRate: calculateCompactRate(tokenBefore, usage.useTokens)
  };
  eventBus.emit('compact:exec', compactExecData);
  // 自动压缩后发送更新的 usage 事件
  eventBus.emit('conversation:usage', { usage })

  return compactedMessages
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
  abortController: AbortController
): Promise<Message[]> {
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
    return messages
  }

  // 只压缩最后一条真实用户消息之前的历史
  const messagesToCompact = messages.slice(0, lastRealUserIdx)
  // 保留当前对话轮次（最后一条真实用户消息及之后的所有内容）
  const messagesToKeep = messages.slice(lastRealUserIdx)

  if (messagesToCompact.length < 2) {
    // 历史消息太少，不值得压缩
    return messages
  }

  try {
    const compactedHistory = await compactMessages(messagesToCompact, abortController)

    // 组合结果示例（工具调用场景）：
    //   [compactNotice(user), summaryMsg(assistant), lastRealUserMsg(user), assistantMsg(assistant), toolResult(user)]
    // 组合结果示例（新查询场景）：
    //   [compactNotice(user), summaryMsg(assistant), newUserQuery(user)]
    // 两种场景均以 user 消息结尾，API 调用合法
    const finalMessages = [...compactedHistory, ...messagesToKeep]

    logDebug(`[Compact] Final messages count: ${finalMessages.length}, kept current turn: ${messagesToKeep.length} messages`)

    return finalMessages
  } catch (error) {
    logError(`Auto-compact failed completely: ${error}. Continuing with original messages`)
    return messages
  }
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
 * 注意：新用户消息的分离和添加由 checkAutoCompact 统一处理
 */
async function executeAutoCompact(
  messages: Message[],
  abortController: AbortController
): Promise<Message[]> {
  // 使用 null tool 作为占位，避免模型调用任何工具
  const tools = [NULL_TOOL]

  // 将压缩指令作为 user message 追加到要压缩的历史对话后
  const messagesWithPrompt = [
    ...prepareMessagesForApi([...messages]),
    buildUserMsg(COMPRESSION_PROMPT)
  ]

  const summaryResponse = await queryLLM(
    messagesWithPrompt,
    [
      {
        type: 'text',
        text: 'An AI assistant that helps summarize coding conversations.'
      }
    ],
    abortController.signal,
    tools,
    'main',
    true // 禁用流式事件
  )

  // 解析 summary 结果，兼容 Anthropic 和 OpenAI 两种格式
  const content = summaryResponse.message.content
  let summary: string | null = null


  if (typeof content === 'string') {
    // OpenAI 格式：content 直接是字符串
    summary = content

  } else if (Array.isArray(content)) {
    // Anthropic 格式：content 是 ContentBlock[] 数组
    const textBlock = content.find(block => block.type === 'text')
    summary = textBlock?.type === 'text' ? textBlock.text : null
  }

  if (!summary || summary.trim().length === 0) {
    // 压缩失败时的备用策略：尝试简单截断而不是完全失败
    const contextLimit = getContextLimit()
    const targetLimit = contextLimit * 0.5 // 截断到50%容量

    logError('压缩生成摘要失败，使用截断策略作为备用方案')
    return truncateMessages(messages, targetLimit)
  }

  // 压缩后的消息结构：
  // 1. User: 压缩通知
  // 2. Assistant: summaryResponse（压缩摘要 + 修正的 usage）
  //
  // 注意：新用户消息的添加由 checkAutoCompact 统一处理，这里不需要处理
  // 重要：summaryResponse 的 usage 包含了整个压缩过程的 token 数（历史对话 + 压缩指令）
  // 需要修正为压缩后消息的实际 token 数（压缩通知 + 摘要）
  const compactNoticeMessage = buildUserMsg(
    `[Context Compression Notice]
The conversation has been automatically compressed due to token limit. Below is a comprehensive summary.`
  )

  // 修正 usage：压缩后的实际 token 数应该是压缩通知 + 摘要内容
  // 估算：压缩通知约 30 tokens，摘要使用 completion_tokens
  const originalUsage = summaryResponse.message.usage as any
  const estimatedNoticeTokens = 30
  const summaryTokens = originalUsage.completion_tokens || originalUsage.output_tokens || 0

  // 创建修正后的 summary message
  const correctedSummaryMessage: typeof summaryResponse = {
    ...summaryResponse,
    message: {
      ...summaryResponse.message,
      usage: {
        ...originalUsage,
        // 修正 input_tokens：压缩通知 + 摘要内容
        input_tokens: estimatedNoticeTokens + summaryTokens,
        // 修正 output_tokens：摘要内容
        output_tokens: summaryTokens,
        // 如果是 OpenAI 格式，也要修正
        prompt_tokens: estimatedNoticeTokens + summaryTokens,
        completion_tokens: summaryTokens,
      }
    }
  }

  // logDebug(`[Compact] Original usage: input=${originalUsage.input_tokens || originalUsage.prompt_tokens}, output=${originalUsage.output_tokens || originalUsage.completion_tokens}`)
  // logDebug(`[Compact] Corrected usage: input=${estimatedNoticeTokens + summaryTokens}, output=${summaryTokens}`)

  // 构建压缩后的消息列表（只包含压缩通知和摘要，不包含新用户消息）
  const compactedMessages: Message[] = [compactNoticeMessage, correctedSummaryMessage]

  return compactedMessages
}

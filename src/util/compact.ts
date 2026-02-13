import { Message } from '../types/message'
import { countTokens } from './tokens'
import { createUserMessage, normalizeMessagesForAPI } from './message'
import { queryLLM } from '../services/api/queryLLM'
import { getModelManager } from '../manager/ModelManager'
import { logDebug, logError } from '../util/log'
import { getEventBus } from '../events/EventSystem'
import { CompactExecData } from '../events/types'
import { Tool } from '../tools/base/Tool'
import { z } from 'zod'
import { getTokens } from './tokens'


/**
 * 触发自动上下文压缩的阈值比例
 * 当上下文使用量超过模型限制的75%时，将自动激活紧凑化处理
 * 提前触发压缩以避免接近token限制时的API调用失败
 */
const AUTO_COMPACT_THRESHOLD_RATIO = 0.75

/**
 * 获取应执行压缩的主模型的上下文长度
 * 通过ModelManager获取当前模型的上下文容量
 */
async function getCompressionModelContextLimit(): Promise<number> {
  try {
    const modelManager = getModelManager()
    const modelProfile = modelManager.getModel('main')

    if (modelProfile?.contextLength) {
      return modelProfile.contextLength
    }
    return 128_000
  } catch (error) {
    return 128_000
  }
}

const COMPRESSION_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
  - Errors that you ran into and how you fixed them
  - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.

2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail

2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.

3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.

4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.

5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.

6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.

7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.

8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.

9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages: 
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
Just compact without using any read tools. **No tool use during summary.**`

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
    const truncatedMessage = createUserMessage(
      `Context truncated due to token limit. ${messages.length - result.length} earlier messages removed. Recent conversation preserved.`
    )
    result.unshift(truncatedMessage)
  }

  logDebug(`[Compact] Truncation result: kept ${result.length} of ${messages.length} messages`)

  return result
}

/**
 * 计算压缩率
 * @param tokenBefore 压缩前的token数
 * @param tokenAfter 压缩后的token数
 * @returns 压缩率小数，如 0.235 表示压缩到23.5%
 */
function calculateCompactRate(tokenBefore: number, tokenAfter: number): number {
  return tokenAfter / tokenBefore;
}

/**
 * 基于主模型能力计算上下文使用阈值
 * 采用主模型上下文长度作为基准，因为压缩任务需要由性能足够的模型处理
 */
async function calculateThresholds(tokenCount: number) {
  const contextLimit = await getCompressionModelContextLimit()
  const autoCompactThreshold = contextLimit * AUTO_COMPACT_THRESHOLD_RATIO

  return {
    isAboveAutoCompactThreshold: tokenCount >= autoCompactThreshold,
    percentUsed: Math.round((tokenCount / contextLimit) * 100),
    tokensRemaining: Math.max(0, autoCompactThreshold - tokenCount),
    contextLimit,
  }
}

/**
 * 根据令牌使用量判断是否应触发自动压缩
 * 采用主模型上下文限制作为判断基准，因为压缩任务需要性能足够的模型处理
 * 只计算输入token数，因为API调用时主要关心的是输入token限制
 */
async function shouldAutoCompact(messages: Message[]): Promise<boolean> {
  if (messages.length < 3) return false

  // 只计算输入token数，这是API调用的主要限制
  const tokens = countTokens(messages);
  const inputTokenCount = tokens.inputTokens;

  const { isAboveAutoCompactThreshold } = await calculateThresholds(inputTokenCount)

  return isAboveAutoCompactThreshold
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
      const contextLimit = await getCompressionModelContextLimit()
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
 * 会自动分离最后的用户消息（如果有），压缩历史消息后再添加回用户消息。
 */
export async function checkAutoCompact(
  messages: Message[],
  abortController: AbortController
): Promise<{ messages: Message[]; wasCompacted: boolean }> {
  // 分离最后的用户消息（如果是真正的用户输入而不是工具结果）
  let newUserMessage: Message | null = null
  let messagesToCheck = messages

  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.type === 'user') {
    // 检查是否是真正的用户查询（而不是 tool result）
    const isToolResult = Array.isArray(lastMessage.message.content) &&
      lastMessage.message.content.length > 0 &&
      lastMessage.message.content[0]?.type === 'tool_result'

    if (!isToolResult) {
      // 最后一条是真正的用户消息，需要分离以便压缩历史消息
      newUserMessage = lastMessage
      messagesToCheck = messages.slice(0, -1)
      logDebug(`[Compact] Separated new user message for compression check`)
    }
  }

  if (!(await shouldAutoCompact(messagesToCheck))) {
    return { messages, wasCompacted: false }
  }

  try {
    const compactedMessages = await compactMessages(messagesToCheck, abortController)

    // 如果有新的用户消息，添加到压缩后的消息列表
    const finalMessages = newUserMessage
      ? [...compactedMessages, newUserMessage]
      : compactedMessages

    logDebug(`[Compact] Final messages count: ${finalMessages.length}, with new user message: ${!!newUserMessage}`)

    return {
      messages: finalMessages,
      wasCompacted: true,
    }
  } catch (error) {
    // 如果压缩完全失败，返回原始消息
    logError(`Auto-compact failed completely: ${error}. Continuing with original messages`)
    return { messages, wasCompacted: false }
  }
}

/**
 * Null Tool - 用于占位避免工具调用
 * 在某些场景下（如压缩），模型必须提供 tools 参数，但我们不希望模型调用任何工具
 * 此工具作为占位符，确保 API 调用合法但不会被实际使用
 */
const NULL_TOOL: Tool = {
  name: 'null',
  description: '占位工具，不应被调用。仅用于满足 API 要求，实际场景中请勿使用此工具。',
  inputSchema: z.object({}),
  isReadOnly: () => true,
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
    ...normalizeMessagesForAPI([...messages]),
    createUserMessage(COMPRESSION_PROMPT)
  ]

  const summaryResponse = await queryLLM(
    messagesWithPrompt,
    [
      {
        type: 'text',
        text: 'You are a helpful AI assistant tasked with summarizing coding conversations.'
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
    const contextLimit = await getCompressionModelContextLimit()
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
  const compactNoticeMessage = createUserMessage(
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

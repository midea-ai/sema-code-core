import { AssistantMessage, UserMessage } from '../../types/message'
import { llmCache } from '../../util/cacheLLM'
import { getEventBus } from '../../events/EventSystem'
import { ThinkingChunkData, TextChunkData } from '../../events/types'
import { logInfo } from '../../util/log'

// 缓存模拟流式输出的速度常量
const CACHE_STREAM_CHUNK_SIZE = 20
const CACHE_STREAM_DELAY = 100

// ============================================================================
// 缓存响应处理
// ============================================================================

export async function tryGetCachedResponse(
  messages: (UserMessage | AssistantMessage)[],
  systemPromptContent: Array<{ type: 'text', text: string }>,
  modelName: string,
  shouldStream: boolean,
  enableThinking: boolean,
  emitChunkEvents: boolean,
  signal?: AbortSignal,
): Promise<AssistantMessage | null> {
  const cachedResponse = llmCache.get(messages, systemPromptContent, modelName, enableThinking)
  if (!cachedResponse) {
    return null
  }

  logInfo('使用LLM缓存响应，节省token消耗')

  const { textContent, thinkingContent, toolUseContent } = extractContentFromResponse(cachedResponse)

  // 如果未启用思考或思考信息为空，从缓存响应中移除思考信息
  if (!enableThinking || !thinkingContent) {
    cachedResponse.message.content = cachedResponse.message.content.filter(
      block => block.type !== 'thinking'
    )
  }

  if (shouldStream) {
    await simulateCachedStreamResponse(
      textContent, thinkingContent, toolUseContent,
      enableThinking, emitChunkEvents, signal
    )
  } else {
    await simulateCachedNonStreamDelay(textContent, thinkingContent, toolUseContent, enableThinking, signal)
  }

  return cachedResponse
}

// ============================================================================
// 缓存流模拟
// ============================================================================

async function simulateCachedStreamResponse(
  textContent: string,
  thinkingContent: string,
  toolUseContent: string,
  enableThinking: boolean,
  emitChunkEvents: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const eventBus = getEventBus()

  // 先模拟 thinking 流（仅在启用思考时）
  if (thinkingContent && emitChunkEvents && enableThinking) {
    await simulateContentStream('thinking', thinkingContent, eventBus, signal)
  }

  // 检查中断
  if (signal?.aborted) return

  // 再模拟 text 流
  if (textContent && emitChunkEvents) {
    await simulateContentStream('text', textContent, eventBus, signal)
  }

  // 检查中断
  if (signal?.aborted) return

  // 工具调用内容模拟延迟
  if (toolUseContent) {
    const delay = calcSimulatedDelay(toolUseContent.length, 5000)
    await new Promise(resolve => setTimeout(resolve, delay))
  }
}

async function simulateCachedNonStreamDelay(
  textContent: string,
  thinkingContent: string,
  toolUseContent: string,
  enableThinking: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const effectiveThinkingLength = enableThinking ? thinkingContent.length : 0
  const totalLength = textContent.length + effectiveThinkingLength + toolUseContent.length
  const delay = calcSimulatedDelay(totalLength, 6000)
  await new Promise<void>((resolve) => {
    const timeoutId = setTimeout(resolve, delay)
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeoutId)
        resolve()
      }, { once: true })
    }
  })
}

async function simulateContentStream(
  type: 'text' | 'thinking',
  content: string,
  eventBus: any,
  signal?: AbortSignal,
): Promise<void> {
  let accumulatedContent = ''
  const eventName = type === 'thinking' ? 'message:thinking:chunk' : 'message:text:chunk'

  for (let i = 0; i < content.length; i += CACHE_STREAM_CHUNK_SIZE) {
    // 检查中断信号
    if (signal?.aborted) return

    const chunk = content.slice(i, i + CACHE_STREAM_CHUNK_SIZE)
    accumulatedContent += chunk

    const chunkData: ThinkingChunkData | TextChunkData = { content: accumulatedContent, delta: chunk }
    eventBus.emit(eventName, chunkData)

    if (i + CACHE_STREAM_CHUNK_SIZE < content.length) {
      await new Promise<void>((resolve) => {
        const timeoutId = setTimeout(resolve, CACHE_STREAM_DELAY)
        if (signal) {
          signal.addEventListener('abort', () => {
            clearTimeout(timeoutId)
            resolve()
          }, { once: true })
        }
      })
    }
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

function calcSimulatedDelay(contentLength: number, maxDelay: number): number {
  return Math.min(
    Math.ceil(contentLength / CACHE_STREAM_CHUNK_SIZE) * CACHE_STREAM_DELAY,
    maxDelay
  )
}

export function setCachedResponse(
  messages: (UserMessage | AssistantMessage)[],
  systemPromptContent: Array<{ type: 'text', text: string }>,
  modelName: string,
  response: AssistantMessage,
  enableThinking: boolean = false
): void {
  llmCache.set(messages, systemPromptContent, modelName, response, enableThinking)
}

export function getCacheSize(): number {
  return llmCache.size()
}

function extractContentFromResponse(response: AssistantMessage): {
  textContent: string;
  thinkingContent: string;
  toolUseContent: string;
} {
  let textContent = ''
  let thinkingContent = ''
  let toolUseContent = ''

  if (response.message.content) {
    response.message.content.forEach(block => {
      if (block.type === 'text') {
        textContent += block.text
      } else if (block.type === 'thinking') {
        thinkingContent += (block as any).thinking || ''
      } else if (block.type === 'tool_use') {
        toolUseContent += JSON.stringify((block as any).input || {})
      }
    })
  }

  return { textContent, thinkingContent, toolUseContent }
}

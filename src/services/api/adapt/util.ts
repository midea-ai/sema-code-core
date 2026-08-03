import { getConfManager } from '../../../manager/ConfManager'
import { getEventBus } from '../../../events/EventSystem'
import { ThinkingChunkData, TextChunkData, SessionErrorData } from '../../../events/types'
import { logDebug, logError } from '../../../util/log'


const STREAM_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟

/**
 * 将外部 AbortSignal 与流式超时合并，返回合并后的 signal 和清理函数。
 * 超时或外部中断任意一个触发时，合并 signal 都会 abort。
 */
export function withStreamTimeout(signal?: AbortSignal, sessionId?: string): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()

  const timeoutId = setTimeout(() => {
    if (!controller.signal.aborted) {
      logDebug('LLM流式请求超时(10min)，返回已积累内容')
      const sessionError: SessionErrorData = {
        type: 'api_error',
        error: {
          code: 'STREAM_TIMEOUT',
          message: 'LLM流式请求超时(10min)',
        },
      }
      getEventBus().emit('session:error', sessionError, sessionId)
      logError(`会话错误 [STREAM_TIMEOUT]: LLM流式请求超时(10min)`)
      controller.abort()
    }
  }, STREAM_TIMEOUT_MS)

  const handleAbortSignal = () => controller.abort()
  signal?.addEventListener('abort', handleAbortSignal, { once: true })

  const cleanup = () => {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', handleAbortSignal)
  }

  return { signal: controller.signal, cleanup }
}

export function emitChunkEvent(
  eventBus: any,
  type: 'text' | 'thinking',
  id: string,
  delta: string,
  sessionId?: string,
) {
  const chunkData: ThinkingChunkData | TextChunkData = { id, delta }
  const eventName = type === 'thinking' ? 'message:thinking:chunk' : 'message:text:chunk'
  eventBus.emit(eventName, chunkData, sessionId)
}

/**
 * 获取事件总线（如果需要发送 chunk 事件）
 */
export function getChunkEventBus(emitChunkEvents: boolean) {
  if (!emitChunkEvents) return null
  const eventBus = getEventBus()
  const shouldEmit = getConfManager().getCoreConfig()?.stream !== false
  return shouldEmit ? eventBus : null
}

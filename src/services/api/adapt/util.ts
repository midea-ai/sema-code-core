import { getConfManager } from '../../../manager/ConfManager'
import { getEventBus } from '../../../events/EventSystem'
import { ThinkingChunkData, TextChunkData, SessionErrorData } from '../../../events/types'
import { logDebug, logError } from '../../../util/log'


const STREAM_TIMEOUT_MS = 10 * 60 * 1000 // 整体超时 10 分钟
const STREAM_IDLE_TIMEOUT_MS = 2 * 60 * 1000 // 空闲超时 2 分钟（无新数据）

/**
 * 将外部 AbortSignal 与流式超时合并，返回合并后的 signal、清理函数和 touch 函数。
 * 超时规则：连续 2 分钟没有新数据（空闲超时）或整体超过 10 分钟，任一触发即 abort。
 * 调用方每收到一个流式包应调用 touch() 重置空闲计时器。
 */
export function withStreamTimeout(signal?: AbortSignal, sessionId?: string): {
  signal: AbortSignal
  cleanup: () => void
  touch: () => void
} {
  const controller = new AbortController()

  const fire = (code: 'STREAM_TIMEOUT' | 'STREAM_IDLE_TIMEOUT', message: string) => {
    if (controller.signal.aborted) return
    logDebug(`${message}，返回已积累内容`)
    const sessionError: SessionErrorData = {
      type: 'api_error',
      error: { code, message },
    }
    getEventBus().emit('session:error', sessionError, sessionId)
    logError(`会话错误 [${code}]: ${message}`)
    controller.abort()
  }

  const totalTimeoutId = setTimeout(
    () => fire('STREAM_TIMEOUT', 'LLM流式请求超时(10min)'),
    STREAM_TIMEOUT_MS,
  )

  let idleTimeoutId: NodeJS.Timeout | undefined
  const armIdle = () => {
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    if (controller.signal.aborted) return
    idleTimeoutId = setTimeout(
      () => fire('STREAM_IDLE_TIMEOUT', 'LLM流式请求空闲超时(2min无新数据)'),
      STREAM_IDLE_TIMEOUT_MS,
    )
  }
  armIdle()

  const handleAbortSignal = () => controller.abort()
  signal?.addEventListener('abort', handleAbortSignal, { once: true })

  const cleanup = () => {
    clearTimeout(totalTimeoutId)
    if (idleTimeoutId) clearTimeout(idleTimeoutId)
    signal?.removeEventListener('abort', handleAbortSignal)
  }

  return { signal: controller.signal, cleanup, touch: armIdle }
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

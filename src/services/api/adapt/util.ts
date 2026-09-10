import { getConfManager } from '../../../manager/ConfManager'
import { getEventBus } from '../../../events/EventSystem'
import { ThinkingChunkData, TextChunkData, SessionErrorData } from '../../../events/types'
import { logDebug, logError } from '../../../util/log'
import { UserMsg, AiMessage } from '../../../types/message'
import { ThinkingHistoryPolicy } from '../../../types/model'


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

const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

/**
 * 按模型的历史思考回传策略过滤 assistant 消息中的 thinking 块。
 *
 * - preserve：原样返回。
 * - current_turn：轮次边界取最后一条带 checkpointSeq 的 user 消息（只有 startQuery 生成的真实输入带它，
 *   工具结果 / 压缩摘要 / 上下文重建 / 中断哨兵都没有）；只清除边界之前的 assistant 思考块。
 *   找不到边界（如子代理会话）时保守地原样返回。
 * - omit：清除全部 assistant 思考块。
 *
 * 只动 assistant 消息里的 thinking / redacted_thinking，其他块保持原引用；过滤后 content 为空则丢弃整条消息。
 * 只新建被改动的消息对象和外层数组，原始历史不被修改。
 */
export function applyThinkingHistoryPolicy(
  messages: (UserMsg | AiMessage)[],
  policy: ThinkingHistoryPolicy,
): (UserMsg | AiMessage)[] {
  if (policy === 'preserve') return messages

  let boundary = -1
  if (policy === 'current_turn') {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type === 'user' && m.checkpointSeq !== undefined) {
        boundary = i
        break
      }
    }
    if (boundary === -1) return messages
  }

  const result: (UserMsg | AiMessage)[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const inScope = policy === 'omit' || i < boundary
    if (!inScope || m.type !== 'assistant') {
      result.push(m)
      continue
    }
    const content = m.message.content
    if (!Array.isArray(content) || !content.some(block => THINKING_BLOCK_TYPES.has(block.type))) {
      result.push(m)
      continue
    }
    const filtered = content.filter(block => !THINKING_BLOCK_TYPES.has(block.type))
    if (filtered.length === 0) continue
    result.push({ ...m, message: { ...m.message, content: filtered } })
  }
  return result
}

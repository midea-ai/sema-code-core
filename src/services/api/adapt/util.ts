import { getConfManager } from '../../../manager/ConfManager'
import { getEventBus } from '../../../events/EventSystem'
import { ThinkingChunkData, TextChunkData } from '../../../events/types'

export const MAIN_QUERY_TEMPERATURE = 0.7

export function emitChunkEvent(
  eventBus: any,
  type: 'text' | 'thinking',
  content: string,
  delta: string
) {
  const chunkData: ThinkingChunkData | TextChunkData = { content, delta }
  const eventName = type === 'thinking' ? 'message:thinking:chunk' : 'message:text:chunk'
  eventBus.emit(eventName, chunkData)
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

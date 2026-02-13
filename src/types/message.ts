import { UUID } from './uuid'
import Anthropic from '@anthropic-ai/sdk'

// 完整工具使用结果类型
export type FullToolUseResult = {
  data: unknown // 匹配工具的 `Output` 类型
  resultForAssistant: Anthropic.ToolResultBlockParam['content']
}

// 工具执行后的控制信号（用于触发上下文重建等操作）
export type ToolControlSignal = {
  rebuildContext?: {
    reason: 'mode_changed'
    newMode: 'Agent' | 'Plan'
    // 重建消息历史时使用的新消息内容
    rebuildMessage?: Array<{
      type: 'text'
      text: string
    }>
  }
}

export type UserMessage = {
  message: Anthropic.MessageParam
  type: 'user'
  uuid: UUID
  toolUseResult?: FullToolUseResult
  controlSignal?: ToolControlSignal  // 工具执行后的控制信号
}

export type AssistantMessage = {
  durationMs: number
  message: Anthropic.Message
  type: 'assistant'
  uuid: UUID
}

// 每个数组项可以是单条消息或消息-响应对
export type Message = UserMessage | AssistantMessage 


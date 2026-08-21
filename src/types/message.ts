import { UUID } from './uuid'
import Anthropic from '@anthropic-ai/sdk'
import { AgentMode } from './index'

// 完整工具使用结果类型
export type FullToolUseResult = {
  data: unknown // 匹配工具的 `Output` 类型
  resultForAssistant: Anthropic.ToolResultBlockParam['content']
}

// 工具执行后的控制信号（用于触发上下文重建等操作）
export type ToolControlSignal = {
  rebuildContext?: {
    reason: 'mode_changed' | 'tools_loaded'
    newMode?: AgentMode  // 仅 mode_changed 使用
    // 重建消息历史时使用的新消息内容
    rebuildMessage?: Array<{
      type: 'text'
      text: string
    }>
  }
}

// 输入来源：user=真实用户输入；cron=定时任务自动触发。
// 后续新增自动来源（如后台任务通知）时在此扩展枚举，UI 按来源渲染标签
export type InputSource = 'user' | 'cron'

// 用户粘贴的图片附件（base64，无系统文件路径）
export interface InputImageAttachment {
  type: 'image';
  data: string;          // base64，不含 data: 前缀
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export type UserMsg = {
  message: Anthropic.MessageParam
  type: 'user'
  uuid: UUID
  toolUseResult?: FullToolUseResult
  controlSignal?: ToolControlSignal  // 工具执行后的控制信号
  // Fork 锚点：仅打在真实用户输入消息上，记录该输入发送时本会话已累积的文件快照记录数。
  // 缺失（旧历史 / 工具结果等合成消息）表示该消息不可作为"恢复文件"的 fork 点。
  checkpointSeq?: number
  // 输入来源：仅非 user 来源（如 cron）写入，缺失表示真实用户输入
  source?: InputSource
}

export type AiMessage = {
  durationMs: number
  message: Anthropic.Message
  type: 'assistant'
  uuid: UUID
}

// 每个数组项可以是单条消息或消息-响应对
export type Message = UserMsg | AiMessage


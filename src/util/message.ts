import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { last } from 'lodash-es'
import { Message, UserMessage, AssistantMessage, ToolControlSignal } from '../types/message'
import {
  NO_CONTENT_MESSAGE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE
} from '../constants/message'



// 创建基础助手消息
function baseCreateAssistantMessage(
  content: Anthropic.ContentBlock[],
  extra?: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    type: 'assistant',
    durationMs: 0,
    uuid: randomUUID(),
    message: {
      id: randomUUID(),
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,
    },
    ...extra,
  }
}

// 创建文本助手消息
export function createAssistantMessage(content: string): AssistantMessage {
  return baseCreateAssistantMessage([
    {
      type: 'text' as const,
      text: content === '' ? NO_CONTENT_MESSAGE : content,
      citations: null,
    },
  ])
}

// 创建工具结果停止消息（用户中断）
export function createToolResultStopMessage(
  toolUseID: string,
): Anthropic.ToolResultBlockParam {
  return {
    type: 'tool_result',
    content: CANCEL_MESSAGE,
    is_error: true,
    tool_use_id: toolUseID,
  }
}

// 创建工具结果拒绝消息（用户拒绝权限）
export function createToolResultRejectMessage(
  toolUseID: string,
): Anthropic.ToolResultBlockParam {
  return {
    type: 'tool_result',
    content: REJECT_MESSAGE,
    is_error: true,
    tool_use_id: toolUseID,
  }
}
// 完整工具使用结果类型
export type FullToolUseResult = {
  data: unknown // 匹配工具的 `Output` 类型
  resultForAssistant: Anthropic.ToolResultBlockParam['content']
}

// 创建用户消息
export function createUserMessage(
  content: string | Anthropic.ContentBlockParam[],
  toolUseResult?: FullToolUseResult,
  controlSignal?: ToolControlSignal,
): UserMessage {
  const m: UserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    uuid: randomUUID(),
    toolUseResult,
    controlSignal,
  }
  return m
}


// 处理消息规范化：删除空assistant消息，合并连续user消息，处理空tool_use
export function normalizeMessagesForAPI(
  messages: Message[],
): (UserMessage | AssistantMessage)[] {
  const result: (UserMessage | AssistantMessage)[] = []
  messages.forEach(message => {
    switch (message.type) {
      case 'assistant': {
        // 跳过内容为空的 assistant 消息
        if (!message.message.content || message.message.content.length === 0) {
          return
        }

        // 检查是否有有效内容来决定是否保留这个 assistant 消息
        // 只有 text 和 tool_use 被认为是有效内容，thinking 块不算
        const hasValidContent = message.message.content.some(block => {
          switch (block.type) {
            case 'text':
              return block.text && block.text.trim().length > 0
            case 'tool_use':
              // 允许空对象参数，因为有些工具可能不需要参数
              return block.input && typeof block.input === 'object'
            case 'thinking':
              return false // thinking 块不被认为是有效内容
            default:
              return true // 其他类型的内容块默认保留
          }
        })

        // 如果没有有效内容，删除整个 assistant 消息
        if (!hasValidContent) {
          return
        }

        // 过滤掉空的 thinking、text、tool_use 内容块
        const filteredContent = message.message.content.filter(block => {
          switch (block.type) {
            case 'text':
              return block.text && block.text.trim().length > 0
            case 'tool_use':
              // 允许空对象参数，因为有些工具可能不需要参数
              return block.input && typeof block.input === 'object'
            case 'thinking':
              return 'thinking' in block && typeof block.thinking === 'string' && block.thinking.trim().length > 0
            default:
              return true // 其他类型的内容块默认保留
          }
        })

        result.push({
          ...message,
          message: {
            ...message.message,
            content: filteredContent,
          },
        })
        return
      }
      case 'user': {
        const lastMessage = last(result)
        // 如果上一条也是 user 消息，合并 content
        if (lastMessage?.type === 'user') {
          const lastContent = lastMessage.message.content
          const currentContent = message.message.content
          // 将两者转换为数组形式后合并
          const mergedContent = [
            ...(Array.isArray(lastContent) ? lastContent : [{ type: 'text' as const, text: lastContent }]),
            ...(Array.isArray(currentContent) ? currentContent : [{ type: 'text' as const, text: currentContent }]),
          ]
          result[result.length - 1] = {
            ...lastMessage,
            message: {
              ...lastMessage.message,
              content: mergedContent,
            },
          }
          return
        }
        result.push(message)
        return
      }
    }
  })
  return result
}

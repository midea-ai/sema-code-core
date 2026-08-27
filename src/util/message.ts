import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { last } from 'lodash-es'
import { Message, UserMsg, AiMessage, ToolControlSignal, FullToolUseResult } from '../types/message'
import type { AgentMode } from '../types'
import { generateRulesReminders, generateSkillsReminder, generatePlanReminders } from '../services/agents/genSystemReminder'
import { generateDesignReminders } from '../services/agents/genDesignSystemReminder'
import { getStateManager } from '../manager/StateManager'

// 用户中断消息常量
export const REQ_INTERRUPT_MSG = '[Request interrupted by user]'
export const TOOL_INTERRUPT_MSG =
  '[Tool use interrupted by user]'
export const CANCEL_MSG = "User has canceled this action. Stop and wait for further instructions."
export const REJECT_MSG = "User has rejected this action. Stop and wait for further instructions."

// 用户自定义反馈消息（不中断，继续对话）
export function getCustomFeedbackMessage(userFeedback: string): string {
  return `User has rejected this action. To explain the next steps, the user said:\n${userFeedback}`
}

export const API_ERR_PREFIX = 'API Error'

const SENTINEL_MESSAGES = [REQ_INTERRUPT_MSG, TOOL_INTERRUPT_MSG, CANCEL_MSG, REJECT_MSG] as const

// 判断是否为合成助手消息
export function isSyntheticAiMessage(text: string): boolean {
  return SENTINEL_MESSAGES.includes(text as typeof SENTINEL_MESSAGES[number])
}

// 创建用户消息
export function buildUserMsg(
  content: string | Anthropic.ContentBlockParam[],
  toolUseResult?: FullToolUseResult,
  controlSignal?: ToolControlSignal,
): UserMsg {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: randomUUID(),
    toolUseResult,
    controlSignal,
  }
}


/**
 * 构建 additionalReminders：文件引用、首次查询、Plan 模式信息、skill信息
 */
export async function buildAdditionalReminders(
  systemReminders: Anthropic.ContentBlockParam[],
  messageHistory: Message[],
  agentMode: AgentMode,
  sessionId: string,
  hasSkillTool: boolean = false,
): Promise<Anthropic.ContentBlockParam[]> {
  // 文件引用 每次输入均添加
  const reminders = [...systemReminders]

  // 判断是否为首次查询（消息历史为空），添加首次查询的额外信息 skills\rules
  if (messageHistory.length === 0) {
    // 添加 skills 信息（仅当工具集中包含 Skill 工具时）
    if (hasSkillTool) {
      reminders.push(...await generateSkillsReminder())
    }

    // 添加 rules 信息
    reminders.push(...generateRulesReminders())
  }

  // 判断是否为首次 Plan 模式查询，添加 Plan 模式信息
  const runtime = getStateManager().session(sessionId)
  if (agentMode === 'Plan' && !runtime.isPlanModeInfoSent()) {
    reminders.push(...generatePlanReminders())
    runtime.markPlanModeInfoSent()
  }

  // 判断是否为首次 Design 模式查询，添加 Design 模式信息
  if (agentMode === 'Design' && !runtime.isDesignModeInfoSent()) {
    reminders.push(...generateDesignReminders())
    runtime.markDesignModeInfoSent()
  }

  return reminders
}

// 将 user 消息内容中的 tool_result 块统一排到最前面（稳定排序）
// Anthropic API 要求：assistant 有多个 tool_use 时，下一条 user 消息里所有 tool_result
// 必须连续排在最前面。若中间夹入 text 等其它块（如 skill 的 additionalBlocks），
// 合并后会打断 tool_result 的连续性，导致 400 "tool_use ids were found without
// tool_result blocks immediately after"
function reorderToolResultsFirst(
  content: string | Anthropic.ContentBlockParam[],
): string | Anthropic.ContentBlockParam[] {
  if (!Array.isArray(content)) return content

  const hasToolResult = content.some(block => block.type === 'tool_result')
  const hasOther = content.some(block => block.type !== 'tool_result')
  // 无需重排：没有 tool_result，或全是 tool_result
  if (!hasToolResult || !hasOther) return content

  const toolResults = content.filter(block => block.type === 'tool_result')
  const others = content.filter(block => block.type !== 'tool_result')
  return [...toolResults, ...others]
}

// 处理消息规范化：删除空assistant消息，合并连续user消息，处理空tool_use
export function prepareMessagesForApi(
  messages: Message[],
): (UserMsg | AiMessage)[] {
  const result: (UserMsg | AiMessage)[] = []

  // 第一步：收集所有 tool_use_id，用于验证 tool_result 是否完整
  const toolUseIds = new Set<string>()
  const toolResultIds = new Set<string>()

  messages.forEach(message => {
    if (message.type === 'assistant') {
      message.message.content.forEach(block => {
        if (block.type === 'tool_use') {
          toolUseIds.add(block.id)
        }
      })
    } else if (message.type === 'user') {
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : [{ type: 'text' as const, text: message.message.content }]

      content.forEach(block => {
        if (block.type === 'tool_result') {
          toolResultIds.add(block.tool_use_id)
        }
      })
    }
  })

  // 找出缺少 tool_result 的 tool_use_id
  const missingToolResults = Array.from(toolUseIds).filter(id => !toolResultIds.has(id))

  // 第二步：规范化消息，过滤掉包含缺失 tool_result 的 assistant 消息
  messages.forEach(message => {
    switch (message.type) {
      case 'assistant': {
        // 跳过内容为空的 assistant 消息
        if (!message.message.content || message.message.content.length === 0) {
          return
        }

        // 检查是否包含缺少 tool_result 的 tool_use
        const hasOrphanedToolUse = message.message.content.some(block =>
          block.type === 'tool_use' && missingToolResults.includes(block.id)
        )

        // 如果包含孤立的 tool_use，跳过整个 assistant 消息
        if (hasOrphanedToolUse) {
          return
        }

        // 过滤掉空的内容块
        const filteredContent = message.message.content.filter(block => {
          switch (block.type) {
            case 'text':
              return block.text && block.text.trim().length > 0
            case 'tool_use':
              return block.input && typeof block.input === 'object'
            case 'thinking':
              return 'thinking' in block && typeof block.thinking === 'string' && block.thinking.trim().length > 0
            default:
              return true
          }
        })

        // 过滤后只剩 thinking 块或为空，则整条消息无效，跳过
        const hasValidContent = filteredContent.some(block => block.type !== 'thinking')
        if (!hasValidContent) {
          return
        }

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

  // 最终归一化：确保每条 user 消息里的 tool_result 块都排在最前面
  return result.map(message => {
    if (message.type !== 'user') return message
    const reordered = reorderToolResultsFirst(message.message.content)
    if (reordered === message.message.content) return message
    return {
      ...message,
      message: { ...message.message, content: reordered },
    }
  })
}

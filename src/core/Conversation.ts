import Anthropic from '@anthropic-ai/sdk'

import type { AgentContext } from '../types/agent'
import { Message, AssistantMessage, UserMessage } from '../types/message'
import { queryLLM } from '../services/api/queryLLM'
import {
  normalizeMessagesForAPI,
  createUserMessage,
} from '../util/message'
import { logDebug, logWarn, logInfo } from '../util/log'
import { checkAutoCompact } from '../util/compact'
import { MessageCompleteData } from '../events/types'
import { getTokens } from '../util/tokens'
import { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE } from '../constants/message'
import { getStateManager, MAIN_AGENT_ID } from '../manager/StateManager'
import { getEventBus } from '../events/EventSystem'
import { getTools } from '../tools/base/tools'
import { getMCPManager } from '../services/mcp/MCPManager'
import { getConfManager } from '../manager/ConfManager'
import { formatSystemPrompt, generateTodosReminders } from '../services/agents/genSystemPrompt'
import { generateRulesReminders } from '../util/rules'
import { runToolsConcurrently, runToolsSerially } from './RunTools'


/**
 * 核心查询函数实现
 * 中断检查：
 * 用户输入 → AI响应(包含3个工具调用) → 检查点1 →
 *   工具1 → 检查点3 → 执行工具1 → 检查点4
 *   工具2 → 检查点3 → 执行工具2 → 检查点4
 *   工具3 → 检查点3 → 执行工具3 → 检查点4
 * → 检查点2 → 递归查询...
 */
export async function* query(
  messages: Message[],
  systemPromptContent: Array<{ type: 'text', text: string }>,
  agentContext: AgentContext,
): AsyncGenerator<Message, void> {

  const { agentId, abortController, tools } = agentContext
  const stateManager = getStateManager()
  const agentState = stateManager.forAgent(agentId)

  const isSubagent = agentId != MAIN_AGENT_ID

  // 自动压缩检查（子代理不进行压缩）
  // 在处理新消息前检查，如果需要压缩，会分离出最新的用户消息
  if (!isSubagent) {
    const { messages: processedMessages, wasCompacted } = await checkAutoCompact(messages, abortController)
    if (wasCompacted) {
      logDebug(`[Compact] Before: ${messages.length} messages, After: ${processedMessages.length} messages`)
      logDebug(`[Compact] Compacted messages structure: ${JSON.stringify(processedMessages.map(m => ({
        type: m.type,
        role: m.message.role,
        contentType: Array.isArray(m.message.content)
          ? m.message.content.map((c: any) => c.type)
          : typeof m.message.content
      })), null, 2)}`)
      messages = processedMessages
    }
  }

  // 获取助手响应
  const assistantMessage = await queryLLM(
    normalizeMessagesForAPI(messages),
    systemPromptContent,
    abortController.signal,
    tools,
    agentContext.model,
    isSubagent // 根据上下文决定是否发送 chunk 事件
  )

  // 检查点1: AI响应完成后工具执行前
  if (abortController.signal.aborted) {
    logWarn('检查点1: AI响应完成后工具执行前')
    // 中断信息
    getEventBus().emit('session:interrupted', { agentId, content: INTERRUPT_MESSAGE })

    // 同步消息历史并更新状态（添加中断消息到历史）
    const interruptMessage = createUserMessage([{ type: 'text', text: INTERRUPT_MESSAGE }])
    const updatedMessagesForInterrupt = [...messages, assistantMessage, interruptMessage]
    agentState.finalizeMessages(updatedMessagesForInterrupt)

    return
  }

  yield assistantMessage // 生成助手消息

  // 过滤出工具使用消息
  const toolUseMessages = assistantMessage.message.content.filter(
    _ => _.type === 'tool_use',
  ) as Anthropic.ToolUseBlock[]

  // 提取文本内容
  const textContent = assistantMessage.message.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')

  // 提取 reasoning 内容（从 content 数组中的 thinking 类型块）
  const reasoning = assistantMessage.message.content
    .filter(block => block.type === 'thinking')
    .map(block => (block as any).thinking || '')
    .join('\n')

  const messageCompleteData: MessageCompleteData = {
    agentId,
    reasoning: reasoning,
    content: textContent,
    hasToolCalls: toolUseMessages.length > 0,
    toolCalls: toolUseMessages.map(tool => {
      return {
        name: tool.name,
        args: tool.input as Record<string, any>
      }
    })
  }

  // 使用 EventBus 发送事件
  getEventBus().emit('message:complete', messageCompleteData)

  // 在每次 message:complete 事件后立即发送完整的 conversation:usage 事件（子代理不触发）
  const updatedMessages = [...messages, assistantMessage]
  if (!isSubagent) {
    const usage = getTokens(updatedMessages)
    getEventBus().emit('conversation:usage', { usage })
  }

  // 如果没有工具调用，直接结束对话
  if (!toolUseMessages.length) {
    // 同步消息历史并更新状态
    agentState.finalizeMessages(updatedMessages)
    return
  }

  const toolResults: UserMessage[] = [] // 存储工具执行结果

  // 检查所有工具是否都可以并发运行（只读工具）
  const canRunConcurrently = toolUseMessages.every(msg =>
    tools.find(t => t.name === msg.name)?.isReadOnly?.() ?? false,
  )

  // 根据是否可以并发运行选择不同的执行策略
  if (canRunConcurrently) {
    for await (const message of runToolsConcurrently(
      toolUseMessages,
      assistantMessage,
      agentContext,
    )) {
      yield message
      if (message.type === 'user') {
        toolResults.push(message)
      }
    }
  } else {
    for await (const message of runToolsSerially(
      toolUseMessages,
      assistantMessage,
      agentContext,
    )) {
      yield message
      // 进度消息不发送到服务器，所以不需要为下一轮累积
      if (message.type === 'user') {
        toolResults.push(message)
      }
    }
  }

  // 检查点2: 所有工具执行完成后递归查询前
  if (abortController.signal.aborted) {
    logWarn('检查点2: 所有工具执行完成后递归查询前')

    // 中断信息
    getEventBus().emit('session:interrupted', { agentId, content: INTERRUPT_MESSAGE_FOR_TOOL_USE })

    // 在最后一个工具结果消息中追加中断文本
    if (toolResults.length > 0) {
      const lastToolResult = toolResults[toolResults.length - 1]
      if (Array.isArray(lastToolResult.message.content)) {
        lastToolResult.message.content.push({ type: 'text', text: INTERRUPT_MESSAGE_FOR_TOOL_USE })
      }
    }

    // 先发送完整对话的usage事件 (包含工具执行的token消耗)，子代理不触发
    const fullMessages = [...messages, assistantMessage, ...toolResults]
    if (!isSubagent) {
      const usage = getTokens(fullMessages)
      getEventBus().emit('conversation:usage', { usage })
    }

    // 同步消息历史并更新状态
    agentState.finalizeMessages(fullMessages)

    return
  }

  // 对工具结果进行排序以匹配工具使用消息的顺序
  const orderedToolResults = toolResults.sort((a, b) => {
    const aIndex = toolUseMessages.findIndex(
      tu => tu.id === (a.message.content[0] as any).tool_use_id,
    )
    const bIndex = toolUseMessages.findIndex(
      tu => tu.id === (b.message.content[0] as any).tool_use_id,
    )
    return aIndex - bIndex
  })

  // 处理控制信号，工具执行后可能重建上下文和消息历史
  const {
    systemPromptContent: nextSystemPromptContent,
    agentContext: nextAgentContext,
    nextMessages,
  } = await handleControlSignalRebuild(
    orderedToolResults,
    messages,
    assistantMessage,
    systemPromptContent,
    agentContext,
  )

  // 递归查询 - 使用新的消息历史继续对话
  try {
    yield* query(
      nextMessages,
      nextSystemPromptContent,
      nextAgentContext,
    )
  } catch (error) {
    // 重新抛出错误以保持原始行为
    throw error
  }
}


/**
 * 处理控制信号，重建上下文和消息历史
 * 用于模式切换后重新获取工具集、系统提示和消息历史
 */
async function handleControlSignalRebuild(
  orderedToolResults: UserMessage[],
  messages: Message[],
  assistantMessage: AssistantMessage,
  currentSystemPrompt: Array<{ type: 'text', text: string }>,
  currentAgentContext: AgentContext,
): Promise<{
  systemPromptContent: Array<{ type: 'text', text: string }>
  agentContext: AgentContext
  nextMessages: Message[]
}> {
  // 检测是否有需要重建上下文的控制信号
  const rebuildSignal = orderedToolResults.find(
    result => result.controlSignal?.rebuildContext
  )?.controlSignal?.rebuildContext

  // 没有重建信号，返回原有上下文
  if (!rebuildSignal) {
    return {
      systemPromptContent: currentSystemPrompt,
      agentContext: currentAgentContext,
      nextMessages: [...messages, assistantMessage, ...orderedToolResults],
    }
  }

  logInfo(`检测到模式切换信号，重建上下文: ${rebuildSignal.newMode}`)

  // 重新获取工具集
  const coreConfig = getConfManager().getCoreConfig()
  const builtinTools = getTools(coreConfig?.useTools)
  const mcpTools = getMCPManager().getMCPTools()
  let newTools = [...builtinTools, ...mcpTools]

  // 根据新模式过滤工具
  if (rebuildSignal.newMode === 'Plan') {
    newTools = newTools.filter(tool => tool.name !== 'TodoWrite')
  }

  // 更新代理上下文
  const newAgentContext: AgentContext = {
    ...currentAgentContext,
    tools: newTools,
  }

  // 重新生成系统提示
  const hasTodoWriteTool = newTools.some(tool => tool.name === 'TodoWrite')
  const hasAskUserQuestionTool = newTools.some(tool => tool.name === 'AskUserQuestion')
  const newSystemPromptContent = await formatSystemPrompt({ hasTodoWriteTool, hasAskUserQuestionTool })

  // 根据 rebuildMessage 决定消息历史
  // 如果有 rebuildMessage，说明需要清理上下文，保留新的用户消息并添加首次查询的额外信息
  let nextMessages: Message[]
  if (rebuildSignal.rebuildMessage) {
    // 构建首次查询的额外信息（todos 和 rules）
    const additionalReminders: Anthropic.ContentBlockParam[] = []

    // 添加 todos 信息
    const hasTodoWriteTool = newTools.some(tool => tool.name === 'TodoWrite')
    if (hasTodoWriteTool) {
      const todosReminders = generateTodosReminders()
      additionalReminders.push(...todosReminders)
    }

    // 添加 rules 信息
    const rulesReminders = generateRulesReminders()
    additionalReminders.push(...rulesReminders)

    // 创建包含额外信息的用户消息
    nextMessages = [createUserMessage([
      ...additionalReminders,
      ...rebuildSignal.rebuildMessage
    ])]
  } else {
    nextMessages = [...messages, assistantMessage, ...orderedToolResults]
  }

  logInfo(`上下文重建完成，工具数量: ${newTools.length}`)

  return {
    systemPromptContent: newSystemPromptContent,
    agentContext: newAgentContext,
    nextMessages,
  }
}

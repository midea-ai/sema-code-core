import Anthropic from '@anthropic-ai/sdk'

import type { AgentContext } from '../types/agent'
import { Message, AiMessage, UserMsg } from '../types/message'
import { queryLLM } from '../services/api/queryLLM'
import {
  prepareMessagesForApi,
  buildUserMsg,
} from '../util/message'
import { logWarn, logInfo } from '../util/log'
import { needsAutoCompact, autoCompact, applyMicroCompact } from '../util/compact'
import { MessageCompleteData } from '../events/types'
import { getTokens } from '../util/tokens'
import { REQ_INTERRUPT_MSG, TOOL_INTERRUPT_MSG } from '../util/message'
import { getStateManager, MAIN_AGENT_ID } from '../manager/StateManager'
import { getEventBus } from '../events/EventSystem'
import { getTaskManager } from '../manager/TaskManager'
import { getAvailableTools } from '../tools/base/tools'
import { getConfManager } from '../manager/ConfManager'
import { generateRulesReminders, generateSkillsReminder } from '../services/agents/genSystemReminder'
import { runToolsConcurrently, runToolsSerially } from './RunTools'
import { processFileReferences } from '../util/fileReference'
import { TOOL_NAME_SKILL } from '../prompt/tool'
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from '../prompt/define'


/**
 * 核心 ReAct 会话循环实现
 */
export async function* ReAct(
  messages: Message[],
  systemPromptContent: Array<{ type: 'text', text: string }>,
  agentContext: AgentContext,
): AsyncGenerator<Message, void> {

  const { sessionId, agentId, abortController, tools } = agentContext
  const stateManager = getStateManager()
  const agentState = stateManager.forAgent(agentContext)

  const isSubagent = agentId != MAIN_AGENT_ID

  // 自动压缩检查（子代理不进行压缩）
  // 在处理新消息前检查，如果需要压缩，会分离出最新的用户消息
  if (!isSubagent && await needsAutoCompact(messages)) {
    // 第一道防线：micro 清理（本地替换模型已消费的旧工具结果，不调模型）。
    // 清理无条件生效并随历史落盘；估算显示空间足够时直接跳过全量摘要。
    const micro = applyMicroCompact(messages, sessionId)
    messages = micro.messages

    if (micro.needFullCompact) {
      getTaskManager().disposeSession(sessionId);
      const compactResult = await autoCompact(messages, abortController, sessionId)
      messages = compactResult.messages

      if (compactResult.changed) {
        agentState.updateTodosIntelligently([]);
        agentState.setReadFileTimestamps({});
      }
    }
  }

  // 获取助手响应
  let assistantMessage: AiMessage
  try {
    assistantMessage = await queryLLM(
      prepareMessagesForApi(messages),
      systemPromptContent,
      abortController.signal,
      tools,
      {
        modelPointer: agentContext.model,
        disableChunkEvents: isSubagent, // 根据上下文决定是否发送 chunk 事件
        sessionId,
      }
    )
  } catch (error) {
    // 至少保存用户消息，避免本轮对话历史全部丢失
    if (abortController.signal.aborted) {
      // 用户中断：追加中断提示后保存
      const interruptMessage = buildUserMsg([{ type: 'text', text: REQ_INTERRUPT_MSG }])
      agentState.finalizeMessages([...messages, interruptMessage])
      getEventBus().emit('session:interrupted', { agentId, content: REQ_INTERRUPT_MSG }, sessionId)
    } else {
      // API 错误：仅保存用户消息，不追加中断提示
      agentState.setMessageHistory(messages)
      // 显式等待文件写入完成，避免 fire-and-forget 导致历史丢失
      await agentState.flushHistory()
    }
    throw error
  }

  // AI响应完成后工具执行前
  if (abortController.signal.aborted) {
    // 中断信息
    getEventBus().emit('session:interrupted', { agentId, content: REQ_INTERRUPT_MSG }, sessionId)

    // 同步消息历史并更新状态（添加中断消息到历史）
    const interruptMessage = buildUserMsg([{ type: 'text', text: REQ_INTERRUPT_MSG }])

    // 如果 assistantMessage 包含未执行的 tool_use，需要移除或添加占位 tool_result
    // 方案：如果有 tool_use，则不保存 assistantMessage，只保存中断消息
    const hasToolUse = assistantMessage.message.content.some(b => b.type === 'tool_use')
    const updatedMessagesForInterrupt = hasToolUse
      ? [...messages, interruptMessage]  // 丢弃包含 tool_use 的响应
      : [...messages, assistantMessage, interruptMessage]  // 保留纯文本响应

    agentState.finalizeMessages(updatedMessagesForInterrupt)

    return
  }

  // 检测输出是否被截断（stop_reason === 'max_tokens'）
  const isTruncated = assistantMessage.message.stop_reason === 'max_tokens'
  if (isTruncated) {
    const hasToolCallsInContent = assistantMessage.message.content.some(b => b.type === 'tool_use')
    const errorMsg = hasToolCallsInContent
      ? 'API输出超长导致工具参数截断，可尝试调整模型最大输出token'
      : 'API输出超长导致内容截断，可尝试调整模型最大输出token'
    logWarn(`[Truncation] 模型输出被截断 (max_tokens)，${hasToolCallsInContent ? '存在工具调用导致参数不完整，停止会话循环' : '纯文本输出，作为正常响应处理'}`)
    getEventBus().emit('session:error', {
      type: 'api_error',
      error: { code: 'API_RESPONSE_ERROR', message: errorMsg, details: {} }
    }, sessionId)
    if (hasToolCallsInContent) {
      // 不保存包含不完整工具调用的assistantMessage，避免破坏消息历史的完整性
      const truncationNotice = buildUserMsg([{
        type: 'text',
        text: `${REMINDER_SYS_OPEN}Previous assistant response was truncated due to max_tokens limit while generating tool calls. The incomplete tool calls have been discarded. Please try again with a more concise approach or adjust the output token limit.${REMINDER_SYS_CLOSE}`
      }])
      agentState.finalizeMessages([...messages, truncationNotice])
      return
    }
  }
  yield assistantMessage // 生成助手消息

  // 过滤出工具使用消息
  const toolUseMessages = assistantMessage.message.content.filter(
    _ => _.type === 'tool_use',
  ) as Anthropic.ToolUseBlock[]

  // 提取文本内容
  const textContent = assistantMessage.message.content
    .filter(block => block.type === 'text')
    .map(block => (block as Anthropic.TextBlock).text)
    .join('\n')

  // 提取 reasoning 内容（从 content 数组中的 thinking 类型块）
  const reasoning = assistantMessage.message.content
    .filter(block => block.type === 'thinking')
    .map(block => (block as any).thinking || '')
    .join('\n')

  const messageCompleteData: MessageCompleteData = {
    id: assistantMessage.message.id,
    agentId,
    reasoning,
    content: textContent,
    hasToolCalls: toolUseMessages.length > 0,
    toolCalls: toolUseMessages.map(t => ({ name: t.name }))
  }

  // 使用 EventBus 发送事件
  getEventBus().emit('message:complete', messageCompleteData, sessionId)

  // 在每次 message:complete 事件后立即发送完整的 conversation:usage 事件（子代理不触发）
  const updatedMessages = [...messages, assistantMessage]
  if (!isSubagent) {
    const usage = getTokens(updatedMessages)
    getEventBus().emit('conversation:usage', { usage }, sessionId)
  }

  // 如果没有工具调用，直接结束对话
  if (!toolUseMessages.length) {
    // 同步消息历史并更新状态
    agentState.finalizeMessages(updatedMessages)
    return
  }

  const toolResults: UserMsg[] = [] // 存储工具执行结果

  // 检查所有工具是否都可以并发运行（只读工具，或明确标记可并发的工具）
  const canRunConcurrently = toolUseMessages.every(msg => {
    const tool = tools.find(t => t.name === msg.name)
    return tool?.isSafe?.() || tool?.canRunConcurrently?.() || false
  })

  // 工具执行前，把「截至上一轮已完成的对话」刷入内存历史，使工具执行期间的权限检查
  // 持久化仍由轮末 finalizeMessages 负责（不改变现有落盘时机）。
  agentState.setMessageHistory(messages, true)

  // 根据是否可以并发运行选择不同的执行策略
  const runTools = canRunConcurrently ? runToolsConcurrently : runToolsSerially
  for await (const message of runTools(toolUseMessages, assistantMessage, agentContext)) {
    yield message
    if (message.type === 'user') {
      toolResults.push(message)
    }
  }

  // 所有工具执行完成后递归查询前
  if (abortController.signal.aborted) {
    logWarn('所有工具执行完成后递归查询前')

    // 中断信息
    getEventBus().emit('session:interrupted', { agentId, content: TOOL_INTERRUPT_MSG }, sessionId)

    // 在最后一个工具结果消息中追加中断文本
    if (toolResults.length > 0) {
      const lastToolResult = toolResults[toolResults.length - 1]
      if (Array.isArray(lastToolResult.message.content)) {
        lastToolResult.message.content.push({ type: 'text', text: TOOL_INTERRUPT_MSG })
      }
    }

    // 先发送完整对话的usage事件 (包含工具执行的token消耗)，子代理不触发
    const fullMessages = [...messages, assistantMessage, ...toolResults]
    if (!isSubagent) {
      const usage = getTokens(fullMessages)
      getEventBus().emit('conversation:usage', { usage }, sessionId)
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

  // 注入待处理用户消息（仅主代理，有工具结果时）
  if (!isSubagent && orderedToolResults.length > 0) {
    await injectPendingInputsIntoToolResult(orderedToolResults, agentContext)
  }

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
  yield* ReAct(
    nextMessages,
    nextSystemPromptContent,
    nextAgentContext,
  )
}


/**
 * 处理控制信号，重建上下文和消息历史
 * 用于模式切换后重新获取工具集、系统提示和消息历史
 */
async function handleControlSignalRebuild(
  orderedToolResults: UserMsg[],
  messages: Message[],
  assistantMessage: AiMessage,
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

  if (rebuildSignal.reason === 'tools_loaded') {
    logInfo('检测到工具加载信号，重建上下文')
  } else {
    logInfo(`检测到模式切换信号，重建上下文: ${rebuildSignal.newMode}`)
  }

  // 重新获取工具集：子代理走自身重组回调（主代理工具集会击穿子代理的工具隔离）；主代理按会话组装
  let newTools: typeof currentAgentContext.tools
  if (currentAgentContext.rebuildTools) {
    newTools = currentAgentContext.rebuildTools()
  } else if (currentAgentContext.agentId !== MAIN_AGENT_ID) {
    logWarn(`子代理 ${currentAgentContext.agentId} 收到重建信号但无重组回调，保持原工具集`)
    newTools = currentAgentContext.tools
  } else {
    newTools = getAvailableTools(undefined, { sessionId: currentAgentContext.sessionId })
  }

  // 更新代理上下文
  const newAgentContext: AgentContext = {
    ...currentAgentContext,
    tools: newTools,
  }

  // 系统提示为会话级快照，整会话不变，模式切换时直接复用

  // 根据 rebuildMessage 决定消息历史
  // 如果有 rebuildMessage，说明需要清理上下文，保留新的用户消息并添加首次查询的额外信息
  let nextMessages: Message[]
  if (rebuildSignal.rebuildMessage) {
    // 构建首次查询的额外信息（todos 和 rules）
    const additionalReminders: Anthropic.ContentBlockParam[] = []

    // 添加 skills 信息
    const hasSkillTool = newTools.some(tool => tool.name === TOOL_NAME_SKILL)
    if (hasSkillTool) {
      const skillsReminders = generateSkillsReminder()
      additionalReminders.push(...skillsReminders)
    }

    // 添加 rules 信息
    const rulesReminders = generateRulesReminders()
    additionalReminders.push(...rulesReminders)

    // 创建包含额外信息的用户消息
    nextMessages = [buildUserMsg([
      ...additionalReminders,
      ...rebuildSignal.rebuildMessage
    ])]
  } else {
    nextMessages = [...messages, assistantMessage, ...orderedToolResults]
  }

  logInfo(`上下文重建完成，工具数量: ${newTools.length}`)

  return {
    systemPromptContent: currentSystemPrompt,
    agentContext: newAgentContext,
    nextMessages,
  }
}

/**
 * 将队列中待注入的用户消息追加到最后一条工具结果中
 * 从队头连续取 inject 类型，遇到 command 停止
 */
async function injectPendingInputsIntoToolResult(
  orderedToolResults: UserMsg[],
  agentContext: AgentContext,
): Promise<void> {
  const injectItems = getStateManager().session(agentContext.sessionId).consumeInjectInputsBeforeNextCommand()
  if (injectItems.length === 0) return

  const lastResult = orderedToolResults[orderedToolResults.length - 1]

  for (const item of injectItems) {
    // 非静默：发送 input:processing 事件 + 保存到项目输入历史
    if (!item.silent) {
      getEventBus().emit('input:processing', {
        inputId: item.inputId,
        input: item.input,
        originalInput: item.originalInput,
      }, agentContext.sessionId)
      getConfManager().saveUserInputToHistory(item.originalInput || item.input)
    }

    // 处理文件引用
    const fileRefResult = await processFileReferences(item.input, agentContext)
    if (fileRefResult.supplementaryInfo.length > 0) {
      getEventBus().emit('file:reference', {
        references: fileRefResult.supplementaryInfo,
      }, agentContext.sessionId)
    }

    // 构建注入文本（含文件引用 systemReminders）
    const reminderTexts = fileRefResult.systemReminders
      .filter((r: Anthropic.ContentBlockParam): r is Anthropic.TextBlock => r.type === 'text' && !!(r as any).text)
      .map(r => r.text)
      .join('\n')
    const injectText = reminderTexts ? `${item.input}\n${reminderTexts}` : item.input

    // 追加 reminder-sys 到最后一条工具结果
    if (Array.isArray(lastResult.message.content)) {
      lastResult.message.content.push({
        type: 'text',
        text: `${REMINDER_SYS_OPEN}\nNew user message arrived during your task:\n${injectText}\n\nReminder: Once current task finishes, immediately respond to the user's latest message. Do not skip it.\n${REMINDER_SYS_CLOSE}`,
      })
    }
  }

  logInfo(`[inject] 已注入 ${injectItems.length} 条用户消息`)
}

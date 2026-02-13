import Anthropic from '@anthropic-ai/sdk'
import type { Tool } from '../tools/base/Tool'
import type { AgentContext } from '../types/agent'
import { Message, AssistantMessage, UserMessage, ToolControlSignal } from '../types/message'
import {
  createUserMessage,
  createToolResultStopMessage,
} from '../util/message'
import { logError } from '../util/log'
import { formatError } from '../util/format'
import { ToolExecutionCompleteData, ToolExecutionErrorData } from '../events/types'
import { hasPermissionsToUseTool } from '../manager/PermissionManager'
import { getEventBus } from '../events/EventSystem'


// 并发运行工具
export async function* runToolsConcurrently(
  toolUseMessages: Anthropic.ToolUseBlock[],
  assistantMessage: AssistantMessage,
  agentContext: AgentContext,
): AsyncGenerator<Message, void> {
  // 简化版并发执行 - 实际项目中可能需要更复杂的并发控制
  const results = await Promise.all(
    toolUseMessages.map(async (toolUse) => {
      const messages: Message[] = []
      for await (const message of runToolUse(
        toolUse,
        assistantMessage,
        agentContext,
      )) {
        messages.push(message)
      }
      return messages
    })
  )

  // 按顺序输出结果
  for (const messageGroup of results) {
    for (const message of messageGroup) {
      yield message
    }
  }
}

// 串行运行工具
export async function* runToolsSerially(
  toolUseMessages: Anthropic.ToolUseBlock[],
  assistantMessage: AssistantMessage,
  agentContext: AgentContext,
): AsyncGenerator<Message, void> {
  // 按顺序逐个执行工具
  for (const toolUse of toolUseMessages) {
    yield* runToolUse(
      toolUse,
      assistantMessage,
      agentContext,
    )
  }
}

// 执行单个工具使用
export async function* runToolUse(
  toolUse: Anthropic.ToolUseBlock,
  assistantMessage: AssistantMessage,
  agentContext: AgentContext,
): AsyncGenerator<Message, void> {

  const { abortController, tools } = agentContext
  const toolName = toolUse.name
  // 查找对应的工具实例
  const tool = tools.find(t => t.name === toolName)

  // 检查工具是否存在
  if (!tool) {
    // 发送工具出错事件 但不会阻塞agent继续执行
    const toolErrorData: ToolExecutionErrorData = {
      agentId: agentContext.agentId,
      toolName: toolName,
      title: toolName,
      content: `Error: No such tool available: ${toolName}`,
    }
    getEventBus().emit('tool:execution:error', toolErrorData)

    // 返回工具不存在的错误消息
    yield createUserMessage([
      {
        type: 'tool_result',
        content: `Error: No such tool available: ${toolName}`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    return
  }

  const toolInput = toolUse.input as { [key: string]: any }

  try {

    // 检查点3: 单个工具开始前
    if (abortController.signal.aborted) {
      // 在工具开始前就已经中断，说明是因为前面的工具被拒绝/取消导致的
      // 这种情况应该返回 CANCEL_MESSAGE
      const message = createUserMessage([
        createToolResultStopMessage(toolUse.id),
      ])
      yield message
      return
    }

    // 检查权限并调用工具
    for await (const message of checkPermissionsAndCallTool(
      tool,
      toolUse.id,
      toolInput,
      agentContext,
      assistantMessage,
    )) {
      // 检查点4: 工具执行期间
      if (abortController.signal.aborted) {
        // 如果是因为用户点击"拒绝"导致的中断，消息已由 checkPermissionsAndCallTool 正确生成
        // 直接 yield 原消息（包含 REJECT_MESSAGE），不需要覆盖
        const abortReason = (abortController.signal as any).reason
        if (abortReason === 'refuse') {
          yield message
          return
        }
        // 其他原因的中断，返回取消消息
        const resultMessage = createUserMessage([
          createToolResultStopMessage(toolUse.id),
        ])
        yield resultMessage
        return
      }

      yield message // 生成消息
    }
  } catch (e) {
    logError(e) // 记录错误

    // 即使在错误情况下，也要确保生成工具结果以清除状态
    const errorContent = `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`
    const errorMessage = createUserMessage([
      {
        type: 'tool_result',
        content: errorContent,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    yield errorMessage
  }
}

// 检查权限并调用工具
export async function* checkPermissionsAndCallTool(
  tool: Tool,
  toolUseID: string,
  input: { [key: string]: any },
  agentContext: AgentContext,
  assistantMessage: AssistantMessage,
): AsyncGenerator<UserMessage, void> {

  const { abortController } = agentContext

  // 使用 zod 验证输入类型
  const isValidInput = tool.inputSchema.safeParse(input)
  if (!isValidInput.success) {
    // 为常见情况创建更有帮助的错误消息
    let errorMessage = `InputValidationError: ${isValidInput.error.message}`

    // 发送工具出错事件 但不会阻塞agent继续执行
    const toolErrorData: ToolExecutionErrorData = {
      agentId: agentContext.agentId,
      toolName: tool.name,
      title: tool.getDisplayTitle?.(input as never) || tool.name,
      content: errorMessage,
    }
    getEventBus().emit('tool:execution:error', toolErrorData)

    // 返回输入验证错误
    yield createUserMessage([
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  // 验证输入值。每个工具都有自己的验证逻辑
  const isValidCall = await tool.validateInput?.(
    input as never,
    agentContext
  )
  if (isValidCall?.result === false) {

    // 发送工具出错事件 但不会阻塞agent继续执行
    const errorMessage = isValidCall!.message || '工具调用验证失败'
    const toolErrorData: ToolExecutionErrorData = {
      agentId: agentContext.agentId,
      toolName: tool.name,
      title: tool.getDisplayTitle?.(input as never) || tool.name,
      content: errorMessage,
    }
    getEventBus().emit('tool:execution:error', toolErrorData)

    // 返回验证失败消息
    yield createUserMessage([
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  // 权限检查
  if (!tool.isReadOnly?.()) {
    // 在权限检查前，先检查是否已经被中断
    // 如果已经中断，说明是因为前面的工具被拒绝/取消，后续工具应该返回 CANCEL_MESSAGE
    if (abortController.signal.aborted) {
      yield createUserMessage([
        createToolResultStopMessage(toolUseID),
      ])
      return
    }

    const permissionResult = await hasPermissionsToUseTool(
      tool,
      input as never,
      abortController,
      assistantMessage,
      agentContext.agentId,
    )
    if (!permissionResult.result) {
      // 权限被拒绝，返回拒绝消息
      // 注意：这里的 permissionResult.message 可能是 REJECT_MESSAGE 或 CANCEL_MESSAGE
      // 取决于 PermissionManager 中的处理逻辑
      yield createUserMessage([
        {
          type: 'tool_result',
          content: permissionResult.message,
          is_error: true,
          tool_use_id: toolUseID,
        },
      ])
      return
    }
  }

  // 调用工具
  try {

    // 直接执行工具调用，传递 agentContext
    const generator = tool.call(input as never, agentContext)
    for await (const result of generator) {
      switch (result.type) {
        case 'result':
          if (tool.genToolResultMessage) {
            const toolResult = tool.genToolResultMessage(result.data, input)

            const toolCompleteData: ToolExecutionCompleteData = {
              agentId: agentContext.agentId,
              toolName: tool.name,
              title: toolResult.title,
              summary: toolResult.summary,
              content: toolResult.content,
            }
            getEventBus().emit('tool:execution:complete', toolCompleteData)
          }

          // 提取控制信号（如果存在）
          const controlSignal = (result.data as any)?.controlSignal as ToolControlSignal | undefined

          // 生成工具结果消息
          yield createUserMessage(
            [
              {
                type: 'tool_result',
                content: result.resultForAssistant || String(result.data),
                tool_use_id: toolUseID,
              },
            ],
            {
              data: result.data,
              resultForAssistant: result.resultForAssistant || String(result.data),
            },
            controlSignal,  // 传递控制信号
          )
          return // 工具执行完成，返回
      }
    }
  } catch (error) {
    const content = formatError(error) // 格式化错误信息
    logError(error) // 记录错误

    // 发送工具出错事件 但不会阻塞agent继续执行
    const toolErrorData: ToolExecutionErrorData = {
      agentId: agentContext.agentId,
      toolName: tool.name,
      title: tool.getDisplayTitle?.(input as never) || tool.name,
      content: content,
    }
    getEventBus().emit('tool:execution:error', toolErrorData)

    // 返回工具执行错误消息
    yield createUserMessage([
      {
        type: 'tool_result',
        content,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
  }
}

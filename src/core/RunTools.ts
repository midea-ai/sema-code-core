import Anthropic from '@anthropic-ai/sdk'
import type { Tool } from '../tools/base/Tool'
import type { AgentContext } from '../types/agent'
import { Message, AiMessage, UserMsg, ToolControlSignal } from '../types/message'
import {
  buildUserMsg,
  CANCEL_MSG,
} from '../util/message'
import { logError } from '../util/log'
import { ToolExecutionCompleteData, ToolExecutionErrorData } from '../events/types'
import { checkToolPermission } from '../manager/PermissionManager'
import { getEventBus } from '../events/EventSystem'
import { firePreToolUse, firePostToolUse, firePostToolUseFailure } from '../services/hooks/hookTriggers'
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from '../prompt/define'

/** 将 tool_result 内容（字符串或 block 数组）转为纯文本，供出错事件与 hook 使用 */
function toolContentToText(content: Anthropic.ToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

// hook 注入的上下文文本块（包 system-reminder 壳）
function buildHookContextBlocks(contextBlocks: string[]): Anthropic.ContentBlockParam[] {
  return contextBlocks.map(text => ({
    type: 'text' as const,
    text: `${REMINDER_SYS_OPEN}\n${text}\n${REMINDER_SYS_CLOSE}`,
  }))
}


// 并发运行工具
export async function* runToolsConcurrently(
  toolUseMessages: Anthropic.ToolUseBlock[],
  assistantMessage: AiMessage,
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
  assistantMessage: AiMessage,
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
  assistantMessage: AiMessage,
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
      toolId: toolUse.id,
      toolName: toolName,
      title: toolName,
      content: `Error: Tool "${toolName}" not found`,
      input: toolUse.input as Record<string, any>,
    }
    getEventBus().emit('tool:execution:error', toolErrorData, agentContext.sessionId)

    // 返回工具不存在的错误消息
    yield buildUserMsg([
      {
        type: 'tool_result',
        content: `Error: Tool "${toolName}" not found`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    return
  }

  const toolInput = toolUse.input as { [key: string]: any }

  try {

    // 单个工具开始前
    if (abortController.signal.aborted) {
      // 在工具开始前就已经中断，说明是因为前面的工具被拒绝/取消导致的
      // 这种情况应该返回 CANCEL_MSG
      yield buildUserMsg([{ type: 'tool_result', content: CANCEL_MSG, is_error: true, tool_use_id: toolUse.id }])
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
      // 工具执行期间
      if (abortController.signal.aborted) {
        // 如果是因为用户点击"拒绝"导致的中断，消息已由 checkPermissionsAndCallTool 正确生成
        // 直接 yield 原消息（包含 REJECT_MSG），不需要覆盖
        const abortReason = (abortController.signal as any).reason
        if (abortReason === 'refuse') {
          yield message
          return
        }
        // 工具支持中断（如 Bash），已在内部处理中断并返回部分结果，保留该结果
        if (tool.supportsInterrupt?.()) {
          yield message
          return
        }
        // 工具不支持中断（如 Edit），返回取消消息
        yield buildUserMsg([{ type: 'tool_result', content: CANCEL_MSG, is_error: true, tool_use_id: toolUse.id }])
        return
      }

      yield message // 生成消息
    }
  } catch (e) {
    logError(e) // 记录错误

    // 即使在错误情况下，也要确保生成工具结果以清除状态
    const errorContent = `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`
    const errorMessage = buildUserMsg([
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
  assistantMessage: AiMessage,
): AsyncGenerator<UserMsg, void> {

  const { abortController } = agentContext

  // 使用 zod 验证输入类型
  const isValidInput = tool.toolParams.safeParse(input)
  if (!isValidInput.success) {
    // 为常见情况创建更有帮助的错误消息
    let errorMessage = `InputValidationError: ${isValidInput.error.message}`

    // 发送工具出错事件 但不会阻塞agent继续执行
    const toolErrorData: ToolExecutionErrorData = {
      agentId: agentContext.agentId,
      toolId: toolUseID,
      toolName: tool.name,
      title: tool.getDisplayTitle?.(input as never) || tool.name,
      content: errorMessage,
      input,
    }
    getEventBus().emit('tool:execution:error', toolErrorData, agentContext.sessionId)

    // 返回输入验证错误
    yield buildUserMsg([
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
      toolId: toolUseID,
      toolName: tool.name,
      title: tool.getDisplayTitle?.(input as never) || tool.name,
      content: errorMessage,
      input,
    }
    getEventBus().emit('tool:execution:error', toolErrorData, agentContext.sessionId)

    // 返回验证失败消息
    yield buildUserMsg([
      {
        type: 'tool_result',
        content: errorMessage,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  // PreToolUse hook：deny 拒绝执行并回给模型；allow 跳过权限询问直接执行；
  // 其余（ask/无输出/hook 失败）走原权限流程。deny 独立于权限档位，Bypass 下仍生效
  const preHook = await firePreToolUse(
    agentContext.sessionId,
    agentContext.agentId,
    tool.name,
    input,
    abortController.signal,
  )
  // hook 执行期间（可能长达数十秒）用户可能已中断：仅 hook 实际进入执行链路（ran）时检查，
  // 覆盖 hook 被 kill 后 fail-open 返回 none 的场景；未启用/未配置/未命中时 ran=false，
  // 不走此分支，保持与原行为完全一致
  if (preHook.ran && abortController.signal.aborted) {
    yield buildUserMsg([{ type: 'tool_result', content: CANCEL_MSG, is_error: true, tool_use_id: toolUseID }])
    return
  }
  if (preHook.decision === 'deny') {
    const denyReason = preHook.reason || 'Blocked by PreToolUse hook'
    const toolErrorData: ToolExecutionErrorData = {
      agentId: agentContext.agentId,
      toolId: toolUseID,
      toolName: tool.name,
      title: tool.getDisplayTitle?.(input as never) || tool.name,
      content: denyReason,
      input,
    }
    getEventBus().emit('tool:execution:error', toolErrorData, agentContext.sessionId)

    yield buildUserMsg([
      {
        type: 'tool_result',
        content: denyReason,
        is_error: true,
        tool_use_id: toolUseID,
      },
    ])
    return
  }

  // 权限检查（PreToolUse hook 返回 allow 时跳过，PermissionRequest hook 亦不触发）
  if (preHook.decision !== 'allow' && !tool.isSafe?.()) {
    // 在权限检查前，先检查是否已经被中断
    // 如果已经中断，说明是因为前面的工具被拒绝/取消，后续工具应该返回 CANCEL_MSG
    if (abortController.signal.aborted) {
      yield buildUserMsg([{ type: 'tool_result', content: CANCEL_MSG, is_error: true, tool_use_id: toolUseID }])
      return
    }

    const permissionResult = await checkToolPermission(
      tool,
      input as never,
      abortController,
      assistantMessage,
      agentContext.agentId,
      agentContext.sessionId,
      toolUseID,
    )
    if (!permissionResult.result) {
      // 权限被拒绝，返回拒绝消息
      // 注意：这里的 permissionResult.message 可能是 REJECT_MSG 或 CANCEL_MSG
      // 取决于 PermissionManager 中的处理逻辑
      yield buildUserMsg([
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

    // 直接执行工具调用，注入 currentToolUseID 供工具内部 chunk 事件使用
    const generator = tool.call(input as never, { ...agentContext, currentToolUseID: toolUseID })
    for await (const result of generator) {
      switch (result.type) {
        case 'result': {
          // resultForAssistant 在接口上可选，缺省时按接口契约用 genResultForAssistant 生成
          const resultContent = result.resultForAssistant ?? tool.genResultForAssistant(result.data)
          // 工具正常返回但业务上失败（如 MCP isError）；未进入 Tool 接口，按扩展字段读取
          const isError = (result as { isError?: boolean }).isError === true
          const toolResult = tool.genToolResultMessage?.(result.data, input)

          // 工具正常返回但业务上失败（如 MCP isError）：事件与 hook 走出错路径，与 throw 一致
          if (isError) {
            const errorText = toolResult
              ? (typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content))
              : toolContentToText(resultContent)
            const toolErrorData: ToolExecutionErrorData = {
              agentId: agentContext.agentId,
              toolId: toolUseID,
              toolName: tool.name,
              title: toolResult?.title ?? (tool.getDisplayTitle?.(input as never) || tool.name),
              content: errorText,
              input,
            }
            getEventBus().emit('tool:execution:error', toolErrorData, agentContext.sessionId)
          } else if (toolResult) {
            const toolCompleteData: ToolExecutionCompleteData = {
              agentId: agentContext.agentId,
              toolId: toolUseID,
              toolName: tool.name,
              title: toolResult.title,
              summary: toolResult.summary,
              content: toolResult.content,
            }
            getEventBus().emit('tool:execution:complete', toolCompleteData, agentContext.sessionId)
          }

          // 提取控制信号（如果存在）
          const controlSignal = (result.data as any)?.controlSignal as ToolControlSignal | undefined

          // 成功走 PostToolUse，业务失败走 PostToolUseFailure；exit 2 的 stderr 与 additionalContext 仅回灌模型
          const postHook = isError
            ? await firePostToolUseFailure(
                agentContext.sessionId,
                agentContext.agentId,
                tool.name,
                input,
                toolContentToText(resultContent),
                abortController.signal,
              )
            : await firePostToolUse(
                agentContext.sessionId,
                agentContext.agentId,
                tool.name,
                input,
                resultContent,
                abortController.signal,
              )

          // 生成工具结果消息
          const additionalBlocks = result.additionalBlocks ?? []
          yield buildUserMsg(
            [
              {
                type: 'tool_result',
                content: resultContent,
                tool_use_id: toolUseID,
                ...(isError ? { is_error: true } : {}),
              },
              ...additionalBlocks,
              ...buildHookContextBlocks(postHook.contextBlocks),
            ],
            {
              data: result.data,
              resultForAssistant: resultContent,
            },
            controlSignal,  // 传递控制信号
          )
          return // 工具执行完成，返回
        }
      }
    }
  } catch (error) {
    const content = error instanceof Error ? error.message : String(error)
    logError(error) // 记录错误

    // 发送工具出错事件 但不会阻塞agent继续执行
    const toolErrorData: ToolExecutionErrorData = {
      agentId: agentContext.agentId,
      toolId: toolUseID,
      toolName: tool.name,
      title: tool.getDisplayTitle?.(input as never) || tool.name,
      content: content,
      input,
    }
    getEventBus().emit('tool:execution:error', toolErrorData, agentContext.sessionId)

    // PostToolUseFailure hook：可注入纠错提示（入参校验失败、权限被拒的早退路径不触发）
    const failHook = await firePostToolUseFailure(
      agentContext.sessionId,
      agentContext.agentId,
      tool.name,
      input,
      content,
      abortController.signal,
    )

    // 返回工具执行错误消息
    yield buildUserMsg([
      {
        type: 'tool_result',
        content,
        is_error: true,
        tool_use_id: toolUseID,
      },
      ...buildHookContextBlocks(failHook.contextBlocks),
    ])
  }
}

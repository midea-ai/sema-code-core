import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { Tool } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, getDescription } from './prompt'
import { defaultBuiltInAgentsConfs } from '../../services/agents/defaultBuiltInAgentsConfs'
import { getTools } from '../base/tools'
import { query } from '../../core/Conversation'
import type { AgentContext } from '../../types/agent'

import { createUserMessage } from '../../util/message'
import { getAgentsManager } from '../../services/agents/agentsManager'
import { getStateManager } from '../../manager/StateManager'
import { getEventBus } from '../../events/EventSystem'
import { TaskAgentStartData, TaskAgentEndData } from '../../events/types'
import { logDebug, logError } from '../../util/log'
import { isInterruptedException } from '../../types/errors'
import { calculateStats, formatSummary, extractResultText } from '../../util/agentStats'
import { generateTodosReminders, buildAgentSystemPrompt } from '../../services/agents/genSystemPrompt'
import { generateRulesReminders } from '../../util/rules'

const inputSchema = z.strictObject({
  description: z.string().describe('A short (3-5 word) description of the task'),
  prompt: z.string().describe('The task for the agent to perform'),
  subagent_type: z.string().describe('The type of specialized agent to use for this task'),
})

type Output = {
  agentType: string
  result: string
  durationMs: number
}

export const TaskTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return getDescription()
  },
  inputSchema,
  isReadOnly() {
    // 子代理可能会执行写操作，所以标记为非只读
    return false
  },
  genToolResultMessage({ agentType, result }) {
    return {
      title: `${agentType} agent`,
      summary: `${agentType} agent completed`,
      content: result
    }
  },
  getDisplayTitle(input) {
    return input?.description || TOOL_NAME_FOR_PROMPT
  },
  async *call({ description, prompt, subagent_type }: z.infer<typeof inputSchema>) {
    const start = Date.now()
    const taskId = nanoid()
    const eventBus = getEventBus()
    const stateManager = getStateManager()

    try {
      // 1. 查找对应的 AgentConfig
      const AgentsConfs = getAgentsManager().getAgentsConfs()
      const agentConfig = AgentsConfs.find(
        agent => agent.name.toLowerCase() === subagent_type.toLowerCase()
      )

      if (!agentConfig) {
        const errorMsg = `Unknown agent type: ${subagent_type}. Available types: ${defaultBuiltInAgentsConfs.map(a => a.name).join(', ')}`
        yield {
          type: 'result',
          data: { agentType: subagent_type, result: errorMsg, durationMs: Date.now() - start },
          resultForAssistant: errorMsg,
        }
        return
      }

      logDebug(`Starting ${agentConfig.name} agent with prompt: ${prompt}`)

      // 2. 发送 task:agent:start 事件
      const startEventData: TaskAgentStartData = {
        taskId,
        subagent_type: agentConfig.name,
        description,
        prompt,
      }
      eventBus.emit('task:agent:start', startEventData)

      // 3. 准备子代理的系统提示（包含 agentConfig.prompt + notes + env + gitStatus）
      const systemPromptContent = await buildAgentSystemPrompt(agentConfig.prompt)

      // 4. 获取子代理允许使用的工具（排除 Task 工具，防止嵌套）
      let subagentTools: Tool[]
      if (!agentConfig.tools || agentConfig.tools === '*') {
        subagentTools = getTools().filter(t => t.name !== TOOL_NAME_FOR_PROMPT)
      } else {
        subagentTools = getTools(agentConfig.tools).filter(t => t.name !== TOOL_NAME_FOR_PROMPT)
      }

      logDebug(`Subagent ${agentConfig.name} has ${subagentTools.length} tools available`)

      // 5. 创建用户消息（包含 todos 和 rules 信息）
      const additionalReminders: Anthropic.ContentBlockParam[] = []

      // 只有 TodoWrite 工具在可用工具列表内才添加 todos 信息
      const hasTodoWriteTool = subagentTools.some(tool => tool.name === 'TodoWrite')
      if (hasTodoWriteTool) {
        const todosReminders = generateTodosReminders()
        additionalReminders.push(...todosReminders)
      }

      // 添加 rules 信息
      const rulesReminders = generateRulesReminders()
      additionalReminders.push(...rulesReminders)

      const userMessage = createUserMessage([
        ...additionalReminders,
        { type: 'text' as const, text: prompt }
      ])

      // 6. 获取共享的 AbortController（子代理与主代理共用，中断时一起中断）
      const sharedAbortController = stateManager.currentAbortController

      if (!sharedAbortController) {
        const errorMsg = 'No active AbortController found. Cannot start subagent.'
        yield {
          type: 'result',
          data: { agentType: subagent_type, result: errorMsg, durationMs: Date.now() - start },
          resultForAssistant: errorMsg,
        }
        return
      }

      // 7. 构建子代理上下文
      const subagentContext: AgentContext = {
        agentId: taskId,
        abortController: sharedAbortController,
        tools: subagentTools,
        model: agentConfig.model === 'quick' ? 'quick' : 'main'
      }

      // 8. 执行子代理查询
      const messages = [userMessage]
      let resultText = ''
      const resultMessages = []

      try {
        for await (const message of query(
          messages,
          systemPromptContent,
          subagentContext,
        )) {
          // 将每个消息添加到结果列表中
          resultMessages.push(message)
        }

        // 从收集的消息中提取最后一次 assistant 响应的文本内容
        resultText = extractResultText(resultMessages)
        logDebug(`${agentConfig.name} agent completed. Result length: ${resultText.length}`)

        // 统计 tokens 和工具使用（检查是否被中断，query() 在中断时通过 return 正常结束）
        const isInterrupted = sharedAbortController.signal.aborted
        const stats = calculateStats(resultMessages, start)
        const summary = formatSummary(stats, isInterrupted ? 'interrupted' : 'completed')

        // 清理子代理所有隔离状态
        const subagentState = stateManager.forAgent(taskId)
        subagentState.clearAllState()

        // 发送 task:agent:end 事件
        const endEventData: TaskAgentEndData = {
          taskId,
          status: isInterrupted ? 'interrupted' : 'completed',
          content: summary,
        }
        eventBus.emit('task:agent:end', endEventData)

        const output: Output = {
          agentType: agentConfig.name,
          result: resultText,
          durationMs: Date.now() - start
        }

        yield {
          type: 'result',
          data: output,
          resultForAssistant: resultText,
        }
      } catch (error) {
        // 统计 tokens 和工具使用
        const stats = calculateStats(resultMessages, start)

        // 清理子代理所有隔离状态（失败/中断时也要清理）
        const subagentState = stateManager.forAgent(taskId)
        subagentState.clearAllState()

        // 发送 task:agent:end 失败事件
        const isInterrupted = isInterruptedException(error)
        const summary = isInterrupted
          ? formatSummary(stats, 'interrupted')
          : `Error: ${error instanceof Error ? error.message : String(error)}`

        const endEventData: TaskAgentEndData = {
          taskId,
          status: 'failed',
          content: summary,
        }
        eventBus.emit('task:agent:end', endEventData)

        if (isInterrupted) {
          logDebug(`Subagent ${agentConfig.name} was interrupted`)
          yield {
            type: 'result',
            data: { agentType: agentConfig.name, result: summary, durationMs: Date.now() - start },
            resultForAssistant: summary,
          }
        } else {
          const errorMsg = `Subagent execution failed: ${error instanceof Error ? error.message : String(error)}`
          logError(errorMsg)
          yield {
            type: 'result',
            data: { agentType: agentConfig.name, result: errorMsg, durationMs: Date.now() - start },
            resultForAssistant: errorMsg,
          }
        }
      }
    } catch (error) {
      // 外层错误（配置错误等）
      const errorMsg = `TaskTool error: ${error instanceof Error ? error.message : String(error)}`
      logError(errorMsg)

      // 清理子代理状态（防止内存泄漏）
      const subagentState = stateManager.forAgent(taskId)
      subagentState.clearAllState()

      // 发送失败事件
      const endEventData: TaskAgentEndData = {
        taskId,
        status: 'failed',
        content: errorMsg,
      }
      eventBus.emit('task:agent:end', endEventData)

      yield {
        type: 'result',
        data: { agentType: subagent_type, result: errorMsg, durationMs: Date.now() - start },
        resultForAssistant: errorMsg,
      }
    }
  },
  genResultForAssistant(output: Output) {
    return output.result
  },
} satisfies Tool<typeof inputSchema, Output>

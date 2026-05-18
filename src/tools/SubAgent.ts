import * as fs from 'fs'
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { Tool } from './base/Tool'
import { resolveSubAgentDescription } from '../prompt/tools/subAgent'
import { DEFAULT_BUILT_IN_AGENTS_CONFS } from '../prompt/agents'
import { getAvailableBuiltinTools, SUBAGENT_EXCLUDED_TOOLS } from './base/tools'
import { getMCPManager } from '../services/mcp/MCPManager'
import { ReAct } from '../core/Conversation'
import type { AgentContext } from '../types/agent'

import { buildUserMsg } from '../util/message'
import { getAgentsManager } from '../services/agents/agentsManager'
import { getStateManager } from '../manager/StateManager'
import { getEventBus } from '../events/EventSystem'
import { TaskAgentStartData, TaskAgentEndData } from '../events/types'
import { logDebug, logError } from '../util/log'
import { isInterruptedException } from '../types/errors'
import { calculateStats, formatSummary, pickResultText } from '../util/agentStats'
import { buildAgentSystemPrompt } from '../services/agents/genSystemPrompt'
import { generateRulesReminders } from '../services/agents/genSystemReminder'
import { getTaskManager } from '../manager/TaskManager'
import { getConfManager } from '../manager/ConfManager'
import { TOOL_NAME_SUB_AGENT, TOOL_NAME_RUN_SHELL } from '../prompt/tool'

const TOOL_NAME = TOOL_NAME_SUB_AGENT

const toolParams = z.strictObject({
  title: z.string().describe('A short task label summarizing the agent\'s goal (3-5 words)'),
  instructions: z.string().describe('Full task instructions for the agent to execute'),
  agent_type: z.string().optional().default('Default').describe('Select a specialized agent type for this task'),
  background: z.boolean().optional().describe('Run the agent in the background'),
})

type ToolRes = {
  agentType: string
  result: string
  durationMs: number
}

export const SubAgent = {
  name: TOOL_NAME,
  description() {
    return resolveSubAgentDescription()
  },
  toolParams,
  isSafe() {
    // 子代理可能会执行写操作，所以标记为非只读
    return false
  },
  canRunConcurrently() {
    // 多个 Agent 实例之间互相独立，可并发执行
    return true
  },
  genToolResultMessage({ agentType, result }) {
    return {
      title: `${agentType}`,
      summary: '',
      content: ''
    }
  },
  getDisplayTitle(input) {
    return input?.title || TOOL_NAME
  },
  async *call({ title, instructions, agent_type = 'Default', background }: z.infer<typeof toolParams>, agentContext: any) {
    const start = Date.now()
    const taskId = nanoid()
    const eventBus = getEventBus()
    const sessionId: string = agentContext.sessionId
    const runtime = getStateManager().session(sessionId)

    try {
      // 1. 查找对应的 AgentConfig
      const AgentsConfs = await getAgentsManager().getAgentsInfo()
      const agentConfig = AgentsConfs.find(
        agent => agent.name.toLowerCase() === agent_type.toLowerCase()
      )

      if (!agentConfig) {
        const errorMsg = `Unrecognized agent type: "${agent_type}". Available: ${DEFAULT_BUILT_IN_AGENTS_CONFS.map(a => a.name).join(', ')}`
        yield {
          type: 'result',
          data: { agentType: agent_type, result: errorMsg, durationMs: Date.now() - start },
          resultForAssistant: errorMsg,
        }
        return
      }

      logDebug(`Starting ${agentConfig.name} agent with instructions: ${instructions}`)

      // 3. 准备子代理的系统提示（包含 agentConfig.prompt + notes + env + gitStatus）
      const systemPromptContent = await buildAgentSystemPrompt(agentConfig.prompt)

      // 4. 获取子代理允许使用的工具（排除 任务与代理 工具，防止嵌套）
      let subagentTools: Tool[]
      if (!agentConfig.tools || agentConfig.tools === '*') {
        subagentTools = getAvailableBuiltinTools().filter(t => !SUBAGENT_EXCLUDED_TOOLS.has(t.name))
      } else {
        subagentTools = getAvailableBuiltinTools(agentConfig.tools).filter(t => !SUBAGENT_EXCLUDED_TOOLS.has(t.name))
      }

      // 子代理的 run_shell 工具不支持后台执行：omit background，模型不可见此字段
      subagentTools = subagentTools.map(t => {
        if (t.name === TOOL_NAME_RUN_SHELL) {
          return { ...t, toolParams: (t.toolParams as any).omit({ background: true }) }
        }
        return t
      })

      // 加入 MCP 工具
      const mcpTools = getMCPManager().getMCPTools()
      if (mcpTools.length > 0) {
        subagentTools = [...subagentTools, ...mcpTools]
      }

      logDebug(`Subagent ${agentConfig.name} has ${subagentTools.length} tools available`)

      // 5. 创建用户消息（包含 rules 信息）
      const additionalReminders: Anthropic.ContentBlockParam[] = []

      // 添加 rules 信息
      const rulesReminders = generateRulesReminders()
      additionalReminders.push(...rulesReminders)

      const userMessage = buildUserMsg([
        ...additionalReminders,
        { type: 'text' as const, text: instructions }
      ])

      const disableBackground = getConfManager().getCoreConfig()?.disableBackgroundTasks ?? false

      // 6. 后台模式：独立 AbortController，立即返回（禁用后台任务时跳过）
      if (background && !disableBackground) {
        const taskManager = getTaskManager()
        const toolUseId = agentContext?.currentToolUseID || ''
        const agentModel: 'quick' | 'main' = agentConfig.model === 'quick' ? 'quick' : 'main'

        eventBus.emit('task:agent:start', { taskId, agent_type: agentConfig.name, title, instructions, background: true } satisfies TaskAgentStartData, sessionId)

        taskManager.spawnAgentTask(taskId, sessionId, title, toolUseId, async (bgAbortController) => {
          const bgContext: AgentContext = {
            sessionId,
            agentId: taskId,
            abortController: bgAbortController,
            tools: subagentTools,
            model: agentModel,
          }
          const bgResultMessages: any[] = []
          try {
            for await (const message of ReAct([userMessage], systemPromptContent, bgContext)) {
              bgResultMessages.push(message)
            }
            const isInterrupted = bgAbortController.signal.aborted
            const stats = calculateStats(bgResultMessages, start)
            const summary = formatSummary(stats, isInterrupted ? 'interrupted' : 'completed')
            eventBus.emit('task:agent:end', {
              taskId,
              status: isInterrupted ? 'interrupted' : 'completed',
              content: summary,
            } satisfies TaskAgentEndData, sessionId)
            return {
              result: pickResultText(bgResultMessages),
              usage: {
                totalTokens: stats.totalTokens,
                toolUses: stats.toolUseCount,
                durationMs: stats.durationMs,
              },
            }
          } catch (error) {
            const isInterrupted = isInterruptedException(error) || bgAbortController.signal.aborted
            const stats = calculateStats(bgResultMessages, start)
            const summary = isInterrupted
              ? formatSummary(stats, 'interrupted')
              : `Error: ${error instanceof Error ? error.message : String(error)}`
            eventBus.emit('task:agent:end', {
              taskId,
              status: isInterrupted ? 'interrupted' : 'failed',
              content: summary,
            } satisfies TaskAgentEndData, sessionId)
            throw error
          } finally {
            runtime.forAgent(taskId).clearAllState()
          }
        }, agentConfig.name)

        const launchMsg = `Background agent started.\nagentId: ${taskId} (internal ID — do not share with user)\nIt is running independently. You will be notified when it finishes.\nDo not overlap with this agent's work. Either handle unrelated tasks, or briefly inform the user what was launched and end your turn.`
        yield {
          type: 'result',
          data: { agentType: agentConfig.name, result: launchMsg, durationMs: Date.now() - start },
          resultForAssistant: launchMsg,
        }
        return
      }

      // 7. 创建独立 AbortController，联动主 AC
      const sharedAbortController = runtime.currentAbortController

      if (!sharedAbortController) {
        const errorMsg = 'No active AbortController found — unable to start subagent.'
        yield {
          type: 'result',
          data: { agentType: agent_type, result: errorMsg, durationMs: Date.now() - start },
          resultForAssistant: errorMsg,
        }
        return
      }

      const subAbortController = new AbortController()

      // 联动：主AC abort → 子AC abort
      const onMainAbort = () => subAbortController.abort()
      sharedAbortController.signal.addEventListener('abort', onMainAbort)
      const unlinkAbort = () => {
        sharedAbortController.signal.removeEventListener('abort', onMainAbort)
      }

      // 如果主AC已经abort了，立刻abort子AC
      if (sharedAbortController.signal.aborted) {
        subAbortController.abort()
      }

      // 8. 构建子代理上下文（使用独立AC，继承父会话 sessionId）
      const subagentContext: AgentContext = {
        sessionId,
        agentId: taskId,
        abortController: subAbortController,
        tools: subagentTools,
        model: agentConfig.model === 'quick' ? 'quick' : 'main'
      }

      // 9. 注册前台任务到 TaskManager 和 StateManager
      const taskManager = getTaskManager()
      const toolUseId = agentContext?.currentToolUseID || ''
      taskManager.registerForegroundAgent(taskId, sessionId, title, toolUseId, subAbortController, unlinkAbort, agentConfig.name)
      runtime.addForegroundAgent(taskId)

      // 10. 发送 task:agent:start 事件
      eventBus.emit('task:agent:start', { taskId, agent_type: agentConfig.name, title, instructions, background: false } satisfies TaskAgentStartData, sessionId)

      // 11. 将 generator 消费放入独立 async 函数
      const resultMessages: any[] = []

      const executionPromise = (async () => {
        try {
          for await (const message of ReAct([userMessage], systemPromptContent, subagentContext)) {
            resultMessages.push(message)
          }

          const isInterrupted = subAbortController.signal.aborted
          const stats = calculateStats(resultMessages, start)
          const summary = formatSummary(stats, isInterrupted ? 'interrupted' : 'completed')

          eventBus.emit('task:agent:end', {
            taskId,
            status: isInterrupted ? 'interrupted' : 'completed',
            content: summary,
          } satisfies TaskAgentEndData, sessionId)

          return {
            result: pickResultText(resultMessages),
            usage: {
              totalTokens: stats.totalTokens,
              toolUses: stats.toolUseCount,
              durationMs: stats.durationMs,
            },
          }
        } catch (error) {
          const isInterrupted = isInterruptedException(error) || subAbortController.signal.aborted
          const stats = calculateStats(resultMessages, start)
          const summary = isInterrupted
            ? formatSummary(stats, 'interrupted')
            : `Error: ${error instanceof Error ? error.message : String(error)}`

          eventBus.emit('task:agent:end', {
            taskId,
            status: isInterrupted ? 'interrupted' : 'failed',
            content: summary,
          } satisfies TaskAgentEndData, sessionId)

          throw error
        } finally {
          runtime.forAgent(taskId).clearAllState()
          runtime.removeForegroundAgent(taskId)
        }
      })()

      // 12. Promise.race：等执行完成 or 等转后台信号（禁用后台任务时不注册转后台）
      let transferResolve: (() => void) | null = null
      const transferSignal = new Promise<void>(resolve => {
        transferResolve = resolve
      })
      if (!disableBackground) {
        taskManager.setTransferResolve(taskId, transferResolve!)
      }

      // 创建统一处理 resolve/reject 的派生 Promise
      const completionPromise = executionPromise.then(
        res => ({ type: 'completed' as const, res }),
        err => ({ type: 'error' as const, err })
      )

      const raceResult = await Promise.race([
        completionPromise,
        transferSignal.then(() => ({ type: 'transferred' as const })),
      ])

      // 13. 根据 race 结果处理
      if (raceResult.type === 'completed') {
        const { res } = raceResult
        taskManager.finalizeTask(taskId, 0, res.result, res.usage)

        const output: ToolRes = {
          agentType: agentConfig.name,
          result: res.result,
          durationMs: Date.now() - start,
        }
        yield {
          type: 'result',
          data: output,
          resultForAssistant: res.result,
        }
      } else if (raceResult.type === 'error') {
        const { err } = raceResult
        const isInterrupted = isInterruptedException(err) || subAbortController.signal.aborted
        const stats = calculateStats(resultMessages, start)

        taskManager.finalizeTask(taskId, isInterrupted ? 0 : 1)

        if (isInterrupted) {
          const summary = formatSummary(stats, 'interrupted')
          logDebug(`Subagent ${agentConfig.name} was interrupted`)
          yield {
            type: 'result',
            data: { agentType: agentConfig.name, result: summary, durationMs: Date.now() - start },
            resultForAssistant: summary,
          }
        } else {
          const errorMsg = `Subagent failed: ${err instanceof Error ? err.message : String(err)}`
          logError(errorMsg)
          yield {
            type: 'result',
            data: { agentType: agentConfig.name, result: errorMsg, durationMs: Date.now() - start },
            resultForAssistant: errorMsg,
          }
        }
      } else {
        // 转后台：executionPromise 仍在运行，只是前台不再等待
        const record = taskManager.getTask(taskId)
        if (record) {
          record._promise = completionPromise.then((result) => {
            if (result.type === 'completed') {
              try { fs.writeFileSync(record.filepath, result.res.result) } catch {}
              taskManager.finalizeTask(taskId, 0, result.res.result, result.res.usage)
            } else {
              const isAborted = subAbortController.signal.aborted
              const msg = isAborted
                ? '[Agent interrupted]'
                : `[Agent error: ${result.err instanceof Error ? result.err.message : String(result.err)}]`
              if (!record.output) record.output = msg
              try { fs.appendFileSync(record.filepath, msg) } catch {}
              taskManager.finalizeTask(taskId, isAborted ? 0 : 1)
            }
          })
        }

        const transferMsg = `Agent moved to background.\nagentId: ${taskId}\nIt will continue running independently. You will be notified when it finishes.`
        yield {
          type: 'result',
          data: { agentType: agentConfig.name, result: transferMsg, durationMs: Date.now() - start },
          resultForAssistant: transferMsg,
        }
      }
    } catch (error) {
      // 外层错误（配置错误等）
      const errorMsg = `Agent error: ${error instanceof Error ? error.message : String(error)}`
      logError(errorMsg)

      // 清理子代理状态（防止内存泄漏）
      const subagentState = runtime.forAgent(taskId)
      subagentState.clearAllState()

      // 发送失败事件
      const endEventData: TaskAgentEndData = {
        taskId,
        status: 'failed',
        content: errorMsg,
      }
      eventBus.emit('task:agent:end', endEventData, sessionId)

      yield {
        type: 'result',
        data: { agentType: agent_type, result: errorMsg, durationMs: Date.now() - start },
        resultForAssistant: errorMsg,
      }
    }
  },
  genResultForAssistant(output: ToolRes) {
    return output.result
  },
} satisfies Tool<typeof toolParams, ToolRes>

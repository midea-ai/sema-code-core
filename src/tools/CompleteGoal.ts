import { z } from 'zod'
import { Tool } from './base/Tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/completeGoal'
import { TOOL_NAME_COMPLETE_GOAL } from '../prompt/tool'
import { getEventBus } from '../events/EventSystem'
import { GoalUpdateData } from '../events/types'
import { getStateManager } from '../manager/StateManager'
import { GoalState } from '../types/goal'

// 输入 schema
const toolParams = z.strictObject({
  status: z
    .enum(['achieved', 'blocked'])
    .describe('achieved: every explicit requirement is verified; blocked: no further progress is possible without the user'),
  summary: z
    .string()
    .describe('Short summary of the outcome, or the question the user must answer when blocked'),
})

// 输出类型
interface CompleteGoalOutput {
  applied: boolean           // false = 目标已不处于 running，未覆盖
  status?: GoalState['status']   // 未覆盖且目标已被清除时无状态
}

// 本工具不进 getBuiltinTools：只在目标 running 时由 getAvailableTools / processQuery 按会话追加到工具列表末尾
export const CompleteGoal = {
  name: TOOL_NAME_COMPLETE_GOAL,
  description() {
    return TOOL_DESCRIPTION
  },
  toolParams,
  isSafe() {
    return true
  },
  async validateInput(_input: z.infer<typeof toolParams>, agentContext: any) {
    const goal = getStateManager().session(agentContext.sessionId).getGoal()
    if (goal?.status !== 'running') {
      return {
        result: false,
        message: 'No active goal is running in this session.',
      }
    }
    return { result: true }
  },
  async *call({ status, summary }: z.infer<typeof toolParams>, agentContext: any) {
    const runtime = getStateManager().session(agentContext.sessionId)
    // 可并行调用：call 内再查一次状态，非 running（同回复里已被另一次调用改掉）直接返回不覆盖
    const goal = runtime.getGoal()
    if (goal?.status !== 'running') {
      const data: CompleteGoalOutput = { applied: false, status: goal?.status }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
      return
    }

    const nextStatus: GoalState['status'] = status === 'achieved' ? 'completed' : 'blocked'
    const updated: GoalState = { ...goal, status: nextStatus, summary, updatedAt: Date.now() }
    runtime.setGoal(updated)
    const eventData: GoalUpdateData = { goal: updated, reason: nextStatus }
    getEventBus().emit('goal:update', eventData, agentContext.sessionId)

    const data: CompleteGoalOutput = { applied: true, status: nextStatus }
    yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
  },
  genResultForAssistant(output: CompleteGoalOutput) {
    if (!output.applied) {
      return `The goal is no longer running (status: ${output.status ?? 'cleared'}); nothing changed.`
    }
    return output.status === 'completed'
      ? 'Goal marked as achieved. The autonomous loop ends after this turn.'
      : 'Goal marked as blocked. The autonomous loop pauses after this turn until the user responds.'
  },
} satisfies Tool<typeof toolParams, CompleteGoalOutput>

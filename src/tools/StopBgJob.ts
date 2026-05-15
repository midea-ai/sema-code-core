import { z } from 'zod'
import { Tool } from './base/Tool'
import { getTaskManager } from '../manager/TaskManager'
import { TOOL_NAME_STOP_BG_JOB, TOOL_NAME_RUN_SHELL } from '../prompt/tool'

export const toolParams = z.strictObject({
  job_id: z.string().describe('ID of the background task to terminate'),
})

type In = typeof toolParams
type ToolOut = {
  taskId: string
  message: string
  taskType: string
  command: string
  stopped: boolean
}

export const StopBgJob = {
  name: TOOL_NAME_STOP_BG_JOB,
  description() {
    return `Stop a running background task started by the ${TOOL_NAME_RUN_SHELL} tool with background=true.`
  },
  isSafe() {
    return false
  },
  toolParams,
  async validateInput() {
    return { result: true }
  },
  genToolPermission(input: any) {
    return {
      title: `${TOOL_NAME_STOP_BG_JOB}: ${input?.job_id}`,
      content: `Stop background task ${input?.job_id}`,
    }
  },
  genToolResultMessage(output: ToolOut) {
    return {
      title: output.taskId,
      summary: '',
      content: output.stopped ? `${output.command} · stopped` : output.message,
    }
  },
  getDisplayTitle(input: any) {
    return `${TOOL_NAME_STOP_BG_JOB}: ${input?.job_id}`
  },
  genResultForAssistant(data: ToolOut): string {
    return `[${TOOL_NAME_STOP_BG_JOB}] task_id=${data.taskId} task_type=${data.taskType} stopped=${data.stopped}
- command: ${data.command}
- message: ${data.message}`
  },
  async *call({ job_id }: { job_id: string }, _agentContext: any) {
    const manager = getTaskManager()
    const record = manager.getTask(job_id)

    if (!record) {
      const data: ToolOut = { taskId: job_id, message: `No task found with ID ${job_id}.`, taskType: '', command: '', stopped: false }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
      return
    }

    if (record.status !== 'running') {
      const data: ToolOut = { taskId: job_id, message: `Task is not active (current status: ${record.status}).`, taskType: record.type, command: record.command, stopped: false }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
      return
    }

    const stopped = manager.stopTask(job_id)
    const data: ToolOut = {
      taskId: job_id,
      message: stopped
        ? `Task ${job_id} stopped (${record.command}).`
        : `Could not stop task ${job_id} (${record.command}) — the process may have already exited.`,
      taskType: record.type,
      command: record.command,
      stopped,
    }
    yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
  },
} satisfies Tool<In, ToolOut>

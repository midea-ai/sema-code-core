import { z } from 'zod'
import { Tool } from './base/Tool'
import { getTaskManager } from '../manager/TaskManager'
import { getEventBus } from '../events/EventSystem'
import type { ToolExecutionChunkData } from '../events/types'
import { MAIN_AGENT_ID } from '../manager/StateManager'
import { formatOutput } from '../util/shell'
import { TOOL_NAME_PEEK_BG_JOB, TOOL_NAME_RUN_SHELL } from '../prompt/tool'

export const toolParams = z.strictObject({
  job_id: z.string().describe('ID of the background task whose output you want'),
  wait: z
    .boolean()
    .optional()
    .default(true)
    .describe('When true (default), waits until the task finishes before returning. Set to false to get a snapshot of the current output immediately.'),
  wait_timeout: z
    .number()
    .optional()
    .default(30000)
    .describe('How long to wait (in ms) for task completion when wait is true. Defaults to 30000 (30 seconds).'),
})

type In = typeof toolParams
type ToolOut = {
  taskId: string
  retrievalStatus: string
  taskStatus: string
  taskType: string
  output: string
}

export const PeekBgJob = {
  name: TOOL_NAME_PEEK_BG_JOB,
  description() {
    return `Retrieve the output of a background task started by the ${TOOL_NAME_RUN_SHELL} tool with background=true. Use wait=true (default) to wait for completion, or wait=false to get the current snapshot immediately.`
  },
  isSafe() {
    return true
  },
  supportsInterrupt() {
    return true
  },
  toolParams,
  genToolResultMessage(data: ToolOut) {
    return {
      title: data.taskId,
      summary: '',
      content: data.output || '(no content)',
    }
  },
  getDisplayTitle(input: any) {
    return `${input?.job_id}`
  },
  genResultForAssistant(data: ToolOut): string {
    return `[${TOOL_NAME_PEEK_BG_JOB}] task_id=${data.taskId} task_type=${data.taskType} status=${data.taskStatus} retrieval=${data.retrievalStatus}
- output:
${data.output}`
  },
  async *call({ job_id, wait = true, wait_timeout = 30000 }: { job_id: string; wait?: boolean; wait_timeout?: number }, agentContext: any) {
    const manager = getTaskManager()
    const record = manager.getTask(job_id)

    if (!record) {
      const data: ToolOut = { taskId: job_id, retrievalStatus: 'not_found', taskStatus: 'not_found', taskType: '', output: '' }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
      return
    }

    // wait=false 或任务已完成，直接返回当前快照
    // 已结束任务的 output 已被清空，getTaskOutput 会回退读取输出文件
    if (!wait || record.status !== 'running') {
      const output = truncateOutput(manager.getTaskOutput(job_id))
      const data: ToolOut = { taskId: job_id, retrievalStatus: record.status, taskStatus: record.status, taskType: record.type, output }
      yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
      return
    }

    // wait=true，等待任务完成
    // SubAgent 任务无增量输出，只有 Bash 任务才流式推送
    const isMainAgent = agentContext?.agentId === MAIN_AGENT_ID
    const onChunk = (isMainAgent && record.type !== 'SubAgent') ? (delta: string) => {
      const chunkData: ToolExecutionChunkData = {
        agentId: agentContext.agentId,
        toolId: agentContext.currentToolUseID || '',
        toolName: TOOL_NAME_PEEK_BG_JOB,
        title: `${job_id}`,
        summary: '',
        content: delta,
      }
      getEventBus().emit('tool:execution:chunk', chunkData, agentContext.sessionId)
    } : undefined

    const abortSignal = agentContext?.abortController?.signal
    const finalRecord = await manager.waitForTask(job_id, wait_timeout, onChunk, abortSignal)
    const interrupted = abortSignal?.aborted ?? false
    const output = truncateOutput(manager.getTaskOutput(job_id))
    const retrievalStatus = interrupted ? 'not_ready' : (finalRecord.status === 'running' ? 'timeout' : 'completed')
    const data: ToolOut = { taskId: job_id, retrievalStatus, taskStatus: finalRecord.status, taskType: finalRecord.type, output }
    yield { type: 'result', data, resultForAssistant: this.genResultForAssistant(data) }
  },
} satisfies Tool<In, ToolOut>

function truncateOutput(output: string): string {
  const { truncatedContent } = formatOutput(output)
  return truncatedContent
}

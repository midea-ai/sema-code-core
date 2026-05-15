import { z } from 'zod'
import { Tool } from './base/Tool'
import { getCronManager } from '../manager/CronManager'
import { TOOL_NAME_DEL_CRON, TOOL_NAME_CREATE_CRON } from '../prompt/tool'

const toolParams = z.strictObject({
  id: z.string().describe(`The cron job identifier obtained from ${TOOL_NAME_CREATE_CRON}`),
})

type ToolOut = { id: string }

export const DelCron = {
  name: TOOL_NAME_DEL_CRON,
  description() {
    return `Cancel a scheduled job by its ID (returned by ${TOOL_NAME_CREATE_CRON}). Works for both persisted and session-only jobs.`
  },
  toolParams,
  isSafe() {
    return false
  },
  canRunConcurrently() {
    return true
  },

  async validateInput(input: z.infer<typeof toolParams>) {
    if (!getCronManager().findTask(input.id)) {
      return { result: false, message: `Cron job not found: ${input.id}` }
    }
    return { result: true }
  },

  genResultForAssistant(data: ToolOut) {
    return `Cancelled job ${data.id}.`
  },
  genToolResultMessage(output: ToolOut) {
    return {
      title: output.id,
      summary: `Cancelled: ${output.id}`,
      content: '',
    }
  },
  getDisplayTitle(input: any) {
    return `${TOOL_NAME_DEL_CRON}: ${input?.id ?? ''}`
  },

  async *call({ id }: z.infer<typeof toolParams>) {
    getCronManager().deleteTask(id)
    const data: ToolOut = { id }

    yield {
      type: 'result' as const,
      data,
      resultForAssistant: `Cron job ${id} has been cancelled.`,
    }
  },
} satisfies Tool<typeof toolParams, ToolOut>

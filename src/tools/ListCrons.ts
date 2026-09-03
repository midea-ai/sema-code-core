import { z } from 'zod'
import { Tool } from './base/Tool'
import { getCronManager } from '../manager/CronManager'
import { TOOL_NAME_LIST_CRONS } from '../prompt/tool'

const toolParams = z.strictObject({})

type JobInfo = {
  id: string
  schedule: string
  humanSchedule: string
  task: string
  repeat: boolean
  persist: boolean
}
type ToolOut = { jobs: JobInfo[] }

export const ListCrons = {
  name: TOOL_NAME_LIST_CRONS,
  description() {
    return `List all active cron jobs, both durable and session-only.`
  },
  toolParams,
  isSafe() {
    return true
  },
  canRunConcurrently() {
    return true
  },

  genResultForAssistant(data: ToolOut) {
    if (data.jobs.length === 0) return 'No active cron jobs.'
    const lines = data.jobs.map(
      j => `${j.id} — ${j.humanSchedule} (${j.repeat ? 'recurring' : 'one-shot'}): ${j.task}`
    )
    return `Active cron jobs (${data.jobs.length}):\n${lines.join('\n')}`
  },
  genToolResultMessage(output: ToolOut) {
    return {
      title: '',
      summary: `${output.jobs.length} active job(s)`,
      content: output.jobs.map(j => `${j.id} ${j.humanSchedule}`).join('\n'),
    }
  },
  getDisplayTitle() {
    return TOOL_NAME_LIST_CRONS
  },

  async *call() {
    const cronManager = getCronManager()
    const jobs: JobInfo[] = cronManager.listTasks()
      .filter(t => t.status)
      .map(t => ({
        id: t.id,
        schedule: t.schedule,
        humanSchedule: t.describeCronExpression,
        task: t.task,
        repeat: t.repeat,
        persist: t.persist,
      }))

    const data: ToolOut = { jobs }
    yield {
      type: 'result' as const,
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
} satisfies Tool<typeof toolParams, ToolOut>

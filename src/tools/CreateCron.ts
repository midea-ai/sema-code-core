import { z } from 'zod'
import { Tool } from './base/Tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/createCron'
import { getCronManager, CronManager, CRON_TASKS_FILE } from '../manager/CronManager'
import { calcNextFireAts, describeCronExpression } from '../util/cron'
import { MAIN_AGENT_ID } from '../manager/StateManager'
import { TOOL_NAME_CREATE_CRON, TOOL_NAME_DEL_CRON } from '../prompt/tool'

const toolParams = z.strictObject({
  schedule: z.string().describe("A 5-field cron schedule in local time: \"Min Hour Day Month Weekday\" (e.g. \"0 9 * * 1\" = every Monday at 9:00, \"*/10 * * * *\" = every 10 minutes)."),
  task: z.string().describe("The prompt text to execute each time the job fires."),
  repeat: z.boolean().optional().describe("When true (default), the job runs on every matching schedule until removed or it auto-expires after 10 days. When false, it fires once at the next match and is then auto-removed. Set to false for one-shot reminders."),
  persist: z.boolean().optional().describe(`When true, the job is saved to ${CRON_TASKS_FILE} and persists across restarts. When false (default), it lives only in memory for this session. Only use true if the user wants the schedule to survive after exiting.`),
})

type ToolOut = { id: string; schedule: string; task: string; humanSchedule: string; repeat: boolean; persist: boolean }

export const CreateCron = {
  name: TOOL_NAME_CREATE_CRON,
  description() {
    return TOOL_DESCRIPTION
  },
  toolParams,
  isSafe() {
    return false
  },
  canRunConcurrently() {
    return true
  },

  async validateInput(
    input: z.infer<typeof toolParams>,
    agentContext: any,
  ) {
    if (agentContext.agentId !== MAIN_AGENT_ID) {
      return { result: false, message: `${TOOL_NAME_CREATE_CRON} can only be used by the main agent` }
    }
    const next = calcNextFireAts(input.schedule, Date.now(), 1)[0] ?? null
    if (next === null) {
      return { result: false, message: `Invalid cron expression: "${input.schedule}". Use 5-field format: "M H DoM Mon DoW"` }
    }
    if (next - Date.now() > 31 * 24 * 60 * 60 * 1000) {
      return { result: false, message: 'Cron expression must have at least one match within 31 days' }
    }
    if (getCronManager().listTasks().length >= CronManager.MAX_TASKS) {
      return { result: false, message: `Maximum number of cron tasks (${CronManager.MAX_TASKS}) reached` }
    }
    return { result: true }
  },

  genResultForAssistant(data: ToolOut) {
    const kind = data.repeat ? 'recurring' : 'one-shot'
    const parts = [`Scheduled ${kind} job ${data.id} (${data.humanSchedule}).`]
    if (data.persist) parts.push(`Persisted to ${CRON_TASKS_FILE}.`)
    if (data.repeat) parts.push(`Auto-expires after 10 days. Use ${TOOL_NAME_DEL_CRON} to cancel sooner.`)
    return parts.join(' ')
  },
  genToolResultMessage(output: ToolOut) {
    const raw = `${output.schedule}: ${output.task}`
    const title = raw.length > 50 ? raw.slice(0, 49) + '…' : raw
    return {
      title,
      summary: `Scheduled ${output.id} (${output.humanSchedule})`,
      content: '',
    }
  },
  getDisplayTitle(input: any) {
    return `${TOOL_NAME_CREATE_CRON}: ${input?.schedule ?? ''}`
  },

  async *call(
    { schedule, task, repeat = true, persist = false }: z.infer<typeof toolParams>,
    agentContext: any,
  ) {
    const id = getCronManager().createTask(schedule, task, repeat, persist, agentContext?.sessionId)
    const humanSchedule = describeCronExpression(schedule)
    const data: ToolOut = { id, schedule, task, humanSchedule, repeat, persist }

    yield {
      type: 'result' as const,
      data,
      resultForAssistant: `Cron job ${id} created. Schedule: ${humanSchedule}. Repeat: ${repeat}. Persist: ${persist}.`,
    }
  },
} satisfies Tool<typeof toolParams, ToolOut>

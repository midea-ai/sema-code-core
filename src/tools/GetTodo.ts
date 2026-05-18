import { z } from 'zod'
import { Tool } from './base/Tool'
import { getStateManager } from '../manager/StateManager'
import { TodoTask } from '../types/todoTask'
import { TOOL_NAME_GET_TODO } from '../prompt/tool'

const toolParams = z.strictObject({
  id: z.string().describe('Identifier of the task to look up'),
})

type ToolOut = { task: TodoTask | null }

function renderTaskResult(data: ToolOut): string {
  if (!data.task) return 'Task not found'
  const t = data.task
  const lines = [
    `Task #${t.id}: ${t.title}`,
    `Status: ${t.status}`,
    `Description: ${t.description}`,
  ]
  if (t.progressText) lines.push(`Progress: ${t.progressText}`)
  if (t.blockedBy.length > 0) lines.push(`Blocked by: ${t.blockedBy.map(id => `#${id}`).join(', ')}`)
  if (t.blocks.length > 0) lines.push(`Blocks: ${t.blocks.map(id => `#${id}`).join(', ')}`)
  return lines.join('\n')
}

export const GetTodo = {
  name: TOOL_NAME_GET_TODO,
  description() {
    return `Fetch a task by ID. Returns title, description, status, and dependency graph (blocks / blocked_by).
A task with non-empty blocked_by cannot be started — resolve blockers first.`
  },
  toolParams,
  isSafe() {
    return true
  },
  canRunConcurrently() {
    return true
  },
  genResultForAssistant(data: ToolOut) {
    return renderTaskResult(data)
  },
  getDisplayTitle(input: any) {
    return `${TOOL_NAME_GET_TODO}: ${input?.id ?? ''}`
  },
  async *call({ id }: z.infer<typeof toolParams>, agentContext: any) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)
    const task = agentState.getTodoTask(id) ?? null

    const data: ToolOut = { task }
    yield {
      type: 'result' as const,
      data,
      resultForAssistant: renderTaskResult(data),
    }
  },
} satisfies Tool<typeof toolParams, ToolOut>

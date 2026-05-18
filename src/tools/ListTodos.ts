import { z } from 'zod'
import { Tool } from './base/Tool'
import { getStateManager } from '../manager/StateManager'
import { TOOL_NAME_LIST_TODOS, TOOL_NAME_GET_TODO } from '../prompt/tool'

const toolParams = z.strictObject({})

type TaskSummary = { id: string; title: string; status: string; blocked_by: string[] }
type ToolOut = { tasks: TaskSummary[] }

function renderTaskResult(data: ToolOut): string {
  if (data.tasks.length === 0) return 'No tasks found'
  return data.tasks.map(t => {
    let line = `#${t.id} [${t.status}] ${t.title}`
    if (t.blocked_by.length > 0) line += ` (blocked by ${t.blocked_by.map(id => `#${id}`).join(', ')})`
    return line
  }).join('\n')
}

export const ListTodos = {
  name: TOOL_NAME_LIST_TODOS,
  description() {
    return `List all tasks with summary info: id, title, status, and blocked_by.
Prefer working tasks in ID order — earlier tasks often set up context for later ones. Use ${TOOL_NAME_GET_TODO} for full details.`
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
  getDisplayTitle() {
    return TOOL_NAME_LIST_TODOS
  },
  async *call(_input: z.infer<typeof toolParams>, agentContext: any) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)
    const allTasks = agentState.listTodoTasks()

    // 构建已完成任务 ID 集合，用于过滤已解除的阻塞
    const resolvedTaskIds = new Set(
      allTasks.filter(t => t.status === 'completed').map(t => t.id),
    )

    const tasks: TaskSummary[] = allTasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      blocked_by: t.blockedBy.filter(id => !resolvedTaskIds.has(id)),
    }))

    const data: ToolOut = { tasks }
    yield {
      type: 'result' as const,
      data,
      resultForAssistant: renderTaskResult(data),
    }
  },
} satisfies Tool<typeof toolParams, ToolOut>

import { z } from 'zod'
import { Tool } from './base/Tool'
import { getStateManager } from '../manager/StateManager'
import { TOOL_NAME_UPDATE_TODO, TOOL_NAME_GET_TODO } from '../prompt/tool'

const TaskStatusEnum = z.enum(['pending', 'in_progress', 'completed', 'deleted'])

const toolParams = z.strictObject({
  id: z.string().describe('Identifier of the task to modify'),
  title: z.string().optional().describe('Updated title for the task'),
  description: z.string().optional().describe('Updated description for the task'),
  progress_text: z.string().optional().describe("Text shown while the task is in progress (e.g., \"Building assets\")"),
  status: TaskStatusEnum.optional().describe('Set the task to a new status'),
  blocks: z.array(z.string()).optional().describe('IDs of tasks that depend on this task (this task blocks them)'),
  blocked_by: z.array(z.string()).optional().describe('IDs of tasks that must finish before this one can start'),
})

type ToolOut = {
  success: boolean
  taskId: string
  updatedFields: string[]
  statusChange?: { from: string; to: string }
  error?: string
}

function renderTaskResult(data: ToolOut): string {
  if (!data.success) return data.error || `Task #${data.taskId} not found`
  return `Updated task #${data.taskId} ${data.updatedFields.join(', ')}`
}

export const UpdateTodo = {
  name: TOOL_NAME_UPDATE_TODO,
  description() {
    return `Update a task's status, title, description, progress_text, or dependencies (blocks / blocked_by).
Status flow: pending → in_progress → completed. Use "deleted" to remove a task permanently.
Only mark completed when fully done — if blocked or failing, keep in_progress and create a blocker task. Read task state via ${TOOL_NAME_GET_TODO} before updating.`

  },
  toolParams,
  isSafe() {
    return false
  },
  canRunConcurrently() {
    return true
  },
  genResultForAssistant(data: ToolOut) {
    return renderTaskResult(data)
  },
  getDisplayTitle(input: any) {
    return `${TOOL_NAME_UPDATE_TODO}: ${input?.id ?? ''}`
  },
  async *call(
    { id, title, description, progress_text, status, blocks, blocked_by }: z.infer<typeof toolParams>,
    agentContext: any,
  ) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)

    // 查找任务
    const existing = agentState.getTodoTask(id)
    if (!existing) {
      const data: ToolOut = { success: false, taskId: id, updatedFields: [], error: 'Task not found' }
      yield { type: 'result' as const, data, resultForAssistant: renderTaskResult(data) }
      return
    }

    // 删除
    if (status === 'deleted') {
      const deleted = agentState.deleteTodoTask(id)
      const data: ToolOut = {
        success: deleted,
        taskId: id,
        updatedFields: deleted ? ['deleted'] : [],
        statusChange: deleted ? { from: existing.status, to: 'deleted' } : undefined,
        error: deleted ? undefined : 'Failed to delete task',
      }
      yield { type: 'result' as const, data, resultForAssistant: renderTaskResult(data) }
      return
    }

    // 收集变更
    const updates: Record<string, any> = {}
    const updatedFields: string[] = []

    if (title !== undefined && title !== existing.title) {
      updates.title = title
      updatedFields.push('title')
    }
    if (description !== undefined && description !== existing.description) {
      updates.description = description
      updatedFields.push('description')
    }
    if (progress_text !== undefined && progress_text !== existing.progressText) {
      updates.progressText = progress_text
      updatedFields.push('progress_text')
    }
    if (status !== undefined && status !== existing.status) {
      updates.status = status
      updatedFields.push('status')
    }

    if (Object.keys(updates).length > 0) {
      agentState.updateTodoTask(id, updates)
    }

    // 建立阻塞关系（双向写入）
    if (blocks && blocks.length > 0) {
      for (const blockId of blocks) {
        agentState.blockTask(id, blockId)
      }
      updatedFields.push('blocks')
    }
    if (blocked_by && blocked_by.length > 0) {
      for (const blockerId of blocked_by) {
        agentState.blockTask(blockerId, id)
      }
      updatedFields.push('blocked_by')
    }

    const data: ToolOut = {
      success: true,
      taskId: id,
      updatedFields,
      statusChange: updates.status !== undefined
        ? { from: existing.status, to: updates.status }
        : undefined,
    }
    yield { type: 'result' as const, data, resultForAssistant: renderTaskResult(data) }
  },
} satisfies Tool<typeof toolParams, ToolOut>

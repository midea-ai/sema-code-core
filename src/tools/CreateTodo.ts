import { z } from 'zod'
import { Tool } from './base/Tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/createTodo'
import { getStateManager } from '../manager/StateManager'
import { TOOL_NAME_CREATE_TODO } from '../prompt/tool'

const toolParams = z.strictObject({
  title: z.string().min(1).describe('Short title summarizing the task'),
  description: z.string().min(1).describe('Full description of the work to be done'),
  progress_text: z.string().optional().describe("Text shown while the task is in progress (e.g., \"Compiling project\")"),
})

type ToolOut = { task: { id: string; title: string } }

export const CreateTodo = {
  name: TOOL_NAME_CREATE_TODO,
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
  genResultForAssistant(data: ToolOut) {
    return `Task #${data.task.id} added: ${data.task.title}`
  },
  getDisplayTitle(input: any) {
    return `${TOOL_NAME_CREATE_TODO}: ${input?.title ?? ''}`
  },
  async *call(
    { title, description, progress_text }: z.infer<typeof toolParams>,
    agentContext: any,
  ) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)

    const id = agentState.createTodoTask({
      title,
      description,
      status: 'pending',
      progressText: progress_text,
      blocks: [],
      blockedBy: [],
    })

    const data: ToolOut = { task: { id, title } }
    yield {
      type: 'result' as const,
      data,
      resultForAssistant: `Task #${id} added: ${title}`,
    }
  },
} satisfies Tool<typeof toolParams, ToolOut>

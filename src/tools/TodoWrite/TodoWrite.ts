
import { z } from 'zod'
import { Tool, ValidationResult } from '../base/Tool'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getStateManager } from '../../manager/StateManager'

const TodoItemSchema = z.strictObject({
  content: z.string().min(1),
  status: z
    .enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1),
})

const inputSchema = z.strictObject({
  todos: z.array(TodoItemSchema).describe('The updated todo list'),
})

type TodoItem = z.infer<typeof TodoItemSchema>

function validateTodos(todos: TodoItem[]): ValidationResult {
  // Check for multiple in_progress tasks
  const inProgressTasks = todos.filter(todo => todo.status === 'in_progress')
  if (inProgressTasks.length > 1) {
    return {
      result: false,
      errorCode: 2,
      message: 'Only one task can be in_progress at a time',
      meta: { inProgressTaskCount: inProgressTasks.length },
    }
  }

  // Validate each todo
  for (let i = 0; i < todos.length; i++) {
    const todo = todos[i]
    if (!todo.content?.trim()) {
      return {
        result: false,
        errorCode: 3,
        message: `Todo at index ${i} has empty content`,
        meta: { todoIndex: i },
      }
    }
    if (!todo.activeForm?.trim()) {
      return {
        result: false,
        errorCode: 5,
        message: `Todo at index ${i} has empty activeForm`,
        meta: { todoIndex: i },
      }
    }
  }

  return { result: true }
}

export const TodoWriteTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  genResultForAssistant(result: string | TodoItem[]) {
    return 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable'
  },

  async validateInput({ todos }: z.infer<typeof inputSchema>) {
    const validation = validateTodos(todos)
    if (!validation.result) {
      return validation
    }
    return { result: true }
  },
  async *call({ todos }: z.infer<typeof inputSchema>, agentContext: any) {
    try {
      // Simple validation
      const validation = validateTodos(todos)
      if (!validation.result) {
        yield {
          type: 'result',
          data: `Error: ${validation.message}`,
          resultForAssistant: `Error: ${validation.message}`,
        }
        return
      }

      // 通过 agentContext 更新 todos（使用智能更新，包含事件发送）
      const stateManager = getStateManager()
      const agentState = stateManager.forAgent(agentContext.agentId)
      agentState.updateTodosIntelligently(todos)

      yield {
        type: 'result',
        data: todos, // Return the todos array for rendering
        resultForAssistant: 'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable',
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
      const errorResult = `Error updating todos: ${errorMessage}`

      yield {
        type: 'result',
        data: errorResult,
        resultForAssistant: errorResult,
      }
    }
  },
} satisfies Tool<typeof inputSchema, string | TodoItem[]>

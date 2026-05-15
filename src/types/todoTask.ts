/**
 * 面向 LLM 的任务跟踪类型（区别于 TaskManager 管理的后台进程任务）
 */

export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed'

/**
 * UI 层待办事项展示类型（精简，用于事件推送）
 */
export interface TodoItem {
  id: string
  title: string
  status: TodoTaskStatus
  progressText: string
}

/**
 * 完整任务数据（用于存储和 LLM 交互）
 */
export interface TodoTask {
  id: string
  title: string
  description: string
  status: TodoTaskStatus
  progressText?: string
  blocks: string[]
  blockedBy: string[]
  createdAt: number
  updatedAt: number
}

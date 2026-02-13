import type { Tool } from '../tools/base/Tool'

export type AgentLocate = 'user' | 'project' | 'builtin'

export interface AgentConfig {
  name: string
  description: string
  tools?: string[] | '*'
  prompt: string
  model?: string  // main quick ， 默认main
  locate?: AgentLocate
}

export interface AgentInfo {
  name: string
  description: string
  tools?: string[] | '*'
  model?: string  // main quick ， 默认main
  locate: AgentLocate
}

/**
 * 代理上下文
 * 包含代理执行所需的所有上下文信息
 */
export interface AgentContext {
  /** 代理 ID（主代理为 MAIN_AGENT_ID，子代理为 taskId） */
  agentId: string
  abortController: AbortController
  tools: Tool[]
  /** 模型类型 */
  model?: 'main' | 'quick'
}
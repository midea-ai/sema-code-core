import type { Tool } from '../tools/base/Tool'

export type AgentScope = 'user' | 'project' | 'builtin' | 'plugin'

export interface AgentConfig {
  name: string
  description: string
  tools: string[] | '*'  // 默认 '*' 
  model: string  // quick 对应 quick，其他值均对应 main
  prompt: string
  locate?: AgentScope
  filePath?: string
}

/**
 * 代理上下文
 * 包含代理执行所需的所有上下文信息
 */
export interface AgentContext {
  /** 会话 ID（贯穿状态访问与事件发射，用于多会话隔离） */
  sessionId: string
  /** 代理 ID（主代理为 MAIN_AGENT_ID，子代理为 taskId） */
  agentId: string
  abortController: AbortController
  tools: Tool[]
  /** 子代理专用：上下文重建（tools_loaded 等信号）时重组自身工具集的回调；主代理不设置，走 getAvailableTools */
  rebuildTools?: () => Tool[]
  /** 模型类型 */
  model?: 'main' | 'quick'
  /** 当前正在执行的工具调用ID（由 RunTools 注入，供工具内部发送 chunk 事件使用） */
  currentToolUseID?: string
}
/**
 * MCP (Model Context Protocol) 类型定义
 */

/**
 * MCP Server 传输类型
 */
export type MCPTransportType = 'stdio' | 'sse' | 'http'

/**
 * MCP Server 安装范围类型
 */
export type MCPScopeType = 'project' | 'user'

/**
 * MCP Server 配置
 */
export interface MCPServerConfig {
  /** 服务名称（唯一标识） */
  name: string
  /** 传输类型 */
  transport: MCPTransportType
  /** 服务描述 */
  description?: string
  /** 是否启用，默认 true */
  enabled?: boolean
  /** 允许使用的工具列表，null 或 undefined 表示使用所有工具 */
  useTools?: string[] | null

  // stdio 类型配置
  /** 可执行命令 */
  command?: string
  /** 命令参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
  // /** 工作目录 */
  // cwd?: string

  // sse/http 类型配置
  /** 服务 URL */
  url?: string
  /** 请求头 */
  headers?: Record<string, string>
}

/**
 * MCP 工具定义
 */
export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, any>
    required?: string[]
  }
}

/**
 * MCP 资源定义
 */
export interface MCPResourceDefinition {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

/**
 * MCP 提示模板定义
 */
export interface MCPPromptDefinition {
  name: string
  description?: string
  arguments?: Array<{
    name: string
    description?: string
    required?: boolean
  }>
}

/**
 * MCP Server 能力
 * 先不支持resources、prompts
 */
export interface MCPServerCapabilities {
  tools?: MCPToolDefinition[]
  // resources?: MCPResourceDefinition[]
  // prompts?: MCPPromptDefinition[]
}

/**
 * MCP Server 状态
 */
export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

/**
 * MCP Server 详细信息
 */
export interface MCPServerInfo {
  config: MCPServerConfig
  status: MCPServerStatus
  capabilities?: MCPServerCapabilities
  error?: string
  connectedAt?: number
}

/**
 * MCP 工具调用结果
 */
export interface MCPToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource'
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}

/**
 * MCP 工具调用事件数据
 */
export interface MCPToolCallData {
  toolName: string
  serverName: string
  args: Record<string, unknown>
}

/**
 * MCP 工具完成事件数据
 */
export interface MCPToolCompleteData {
  toolName: string
  serverName: string
  result: MCPToolResult
}

/**
 * MCP 工具错误事件数据
 */
export interface MCPToolErrorData {
  toolName: string
  serverName: string
  error: string
}

/**
 * 宿主（集成 sema-core 的产品）在构造参数里传入的 host 域内容与生效域。
 *
 * 每一条模型 / MCP / hook / skill / 子代理 / 命令配置都有一个来源，叫域：宿主传入的是 host 域，
 * 从文件读到的是 user / project 等域；插件是整体来源，它带的组件跟着插件走，不单独分域。
 * 产品通过 scopes 指定每一类哪些域生效；host 域条目只读且优先，同名时盖掉其他域的。
 */
import type { ModelConfig } from './index'
import type { ImageModelConfig } from './imageModel'
import type { MCPTransportType } from './mcp'
import type { PluginScopeKind } from './plugin'

// ==================== host 域内容 ====================

/** 宿主内置的模型列表与指针（字段同 addModel / addImageModel 入参） */
export interface ModelsInput {
  profiles: ModelConfig[]
  imageProfiles?: ImageModelConfig[]
  /** 主模型，格式 "modelName[provider]"，缺省取 profiles[0]；是没有用户选择时的缺省值，见 ModelManager */
  main?: string
  /** 快速模型，缺省同 main */
  quick?: string
  /** 文生图模型，缺省取 imageProfiles[0]，传 '' 停用文生图 */
  image?: string
}

/** 宿主内置的 MCP 服务（字段同 addMCPServer 入参，去掉 scope） */
export interface MCPServerInput {
  name: string
  transport: MCPTransportType
  description?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** 默认 true；host 条目不受 settings 的 disabledMcpServers 影响 */
  enabled?: boolean
  /** 允许的工具名，null / 缺省表示全部 */
  useTools?: string[] | null
}

/** 宿主内置的 hook：即 hooks.json 里 hooks 字段的内容，键为事件名 */
export type HooksInput = Record<string, Array<{
  matcher?: string
  hooks: Array<{ type?: 'command'; command: string; timeout?: number; failClosed?: boolean }>
}>>

/** 内联 skill：正文与文本子文件只在内存里，磁盘上不留 */
export interface SkillInput {
  name: string
  description: string
  /** SKILL.md 正文 */
  prompt: string
  /** 文本子文件：相对路径 → 内容，模型用 skill 工具的 file 参数读 */
  files?: Record<string, string>
  /** 脚本、图片、模板等所在的磁盘目录（绝对路径），不保护 */
  resourceDir?: string
}

export interface SkillsInput {
  /** 内联 skill */
  items?: SkillInput[]
  /** 产品自带的明文目录，每个目录下是 <skill 名>/SKILL.md */
  dirs?: string[]
}

/** 内联子代理（字段同 addAgentConf 入参，去掉 locate） */
export interface AgentInput {
  name: string
  description: string
  prompt: string
  /** 默认 '*' */
  tools?: string[] | '*'
  /** 'quick' 对应快速模型，其他值均对应主模型 */
  model?: string
}

export interface AgentsInput {
  items?: AgentInput[]
  /** 产品自带的明文目录，每个目录下是 <name>.md */
  dirs?: string[]
}

/** 内联命令（字段同 addCommandConf 入参，去掉 locate） */
export interface CommandInput {
  name: string
  description: string
  prompt: string
  argumentHint?: string | string[]
}

export interface CommandsInput {
  items?: CommandInput[]
  /** 产品自带的明文目录，每个目录下是 <name>.md，子目录成为 dir:name */
  dirs?: string[]
}

// ==================== 生效域 ====================

export type ModelScope = 'host' | 'user'
export type MCPScope = 'host' | 'user' | 'project'
export type HookScope = 'host' | 'user' | 'project'
export type SkillScopeKind = 'host' | 'builtin' | 'user' | 'project'
export type AgentScopeKind = 'host' | 'builtin' | 'user' | 'project'
export type CommandScopeKind = 'host' | 'user' | 'project'

/** 各类生效的域；不写 = 该类全部域生效，要锁定必须显式写。写了但不含 'host' 时，宿主传入的该类内容同样不生效 */
export interface ScopesConfig {
  models?: ModelScope[]
  mcp?: MCPScope[]
  hooks?: HookScope[]
  skills?: SkillScopeKind[]
  agents?: AgentScopeKind[]
  commands?: CommandScopeKind[]
  /** 插件没有 host 域，值是插件的安装位置；[] 表示不加载任何插件 */
  plugins?: PluginScopeKind[]
}

// ==================== 持久化保护 ====================

export interface EncryptionConfig {
  /** 32 字节随机密钥的 base64（44 个字符） */
  key: string
  /** 可选的密钥标识，写进密文开头 */
  keyId?: string
}

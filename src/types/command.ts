export type CommandScope = 'user' | 'project' | 'plugin'

export interface CommandConfig {
  /** 命令名（如 "optimize" 或 "frontend:test"） */
  name: string
  /** 命令描述 */
  description: string
  /** 参数提示（如 "[pr-number] [priority]"） */
  argumentHint?: string | string[]
  /** 命令内容（Markdown body，不含 frontmatter） */
  prompt: string
  /** 作用域 */
  locate?: CommandScope
  /** 来源 */
  from?: string
  /** 源文件路径 */
  filePath?: string
}

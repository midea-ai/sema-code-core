/** 来源：host 为宿主构造时传入（内联或 dirs 目录），只读 */
export type CommandScope = 'host' | 'user' | 'project' | 'plugin'

export interface CommandConfig {
  /** 命令名（如 "optimize" 或 "frontend:test"） */
  name: string
  /** 命令描述 */
  description: string
  /** 参数提示（如 "[pr-number] [priority]"） */
  argumentHint?: string | string[]
  /** 命令内容（Markdown body，不含 frontmatter）；内联命令在查询接口里为 '' */
  prompt: string
  /** 作用域 */
  locate?: CommandScope
  /** 源文件路径；内联命令没有 */
  filePath?: string
  /** 内联命令：正文只在内存里，查询接口不回传 */
  private?: boolean
}

/**
 * Skill 系统类型定义
 */

/** 来源：host 为宿主构造时传入（内联或 dirs 目录），只读 */
export type SkillScope = 'host' | 'user' | 'project' | 'plugin' | 'builtin'

export interface SkillConfig {
  name: string
  description: string
  /** 正文；内联 skill 在查询接口里为 '' */
  prompt: string
  locate?: SkillScope
  /** SKILL.md 路径；内联 skill 没有 */
  filePath?: string
  /** 是否启用（settings 的 disabledSkills 控制，用户级+项目级并集；undefined 视为启用；builtin / host 恒为启用） */
  status?: boolean
  /** 内联 skill：正文与文本子文件只在内存里，不出现在查询接口与事件里 */
  private?: boolean
  /** 内联 skill 的脚本、资源所在磁盘目录（绝对路径） */
  resourceDir?: string
  /** 内联 skill 的文本子文件（相对路径 → 内容）；仅内部持有，查询接口不回传 */
  files?: Record<string, string>
}

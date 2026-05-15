/**
 * Skill 系统类型定义
 */

export type SkillScope = 'user' | 'project' | 'plugin'

export interface SkillConfig {
  name: string
  description: string
  prompt: string
  locate?: SkillScope
  filePath?: string
}
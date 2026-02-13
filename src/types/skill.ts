/**
 * Skill 系统类型定义
 *
 * 实现 Claude Skills 的类型系统，支持渐进式披露和 allowed-tools 软约束
 */

// Skill YAML Frontmatter 类型
export interface SkillMetadata {
  name: string
  description: string
  'allowed-tools'?: string[]
  'when-to-use'?: string
  model?: 'haiku' | 'sonnet' | 'opus' | 'inherit'
  'max-thinking-tokens'?: number
  'disable-model-invocation'?: boolean
  'argument-hint'?: string
  version?: string
}

// 完整 Skill 定义
export interface Skill {
  metadata: SkillMetadata
  content: string          // Markdown body（去除 frontmatter）
  filePath: string         // SKILL.md 的绝对路径
  baseDir: string          // Skill 目录的绝对路径
  locate: 'user' | 'project'  // Skill 来源：user（全局级） 或 project（项目级）
}

// Skill 加载配置
export interface SkillLoaderConfig {
  searchDirs: string[]     // 搜索目录列表
  useCache?: boolean       // 是否使用缓存
}

// Skill 注册表类型
export type SkillRegistry = Map<string, Skill>

// Skill 基本信息（用于 API 返回）
export interface SkillInfo {
  name: string
  description: string
  locate: 'user' | 'project'  // Skill 来源：user（全局级） 或 project（项目级）
}

/**
 * Skill 解析器
 *
 * 负责解析 SKILL.md 文件，提取 YAML frontmatter 和 Markdown 内容
 */

import { readFileSync } from 'fs'
import matter from 'gray-matter'
import { Skill, SkillMetadata } from '../../types/skill'

/**
 * 解析 SKILL.md 文件
 * @param filePath SKILL.md 的绝对路径
 * @param baseDir Skill 目录的绝对路径
 * @param locate Skill 来源：'user' 或 'project'
 * @returns 解析后的 Skill 对象
 */
export function parseSkillFile(filePath: string, baseDir: string, locate: 'user' | 'project'): Skill {
  const fileContent = readFileSync(filePath, 'utf-8')

  // 使用 gray-matter 解析 YAML frontmatter
  const { data, content } = matter(fileContent)

  // 验证必需字段
  if (!data.name || !data.description) {
    throw new Error(`Invalid SKILL.md: missing 'name' or 'description' in ${filePath}`)
  }

  // 解析 allowed-tools
  const allowedTools = parseAllowedTools(data['allowed-tools'])

  const metadata: SkillMetadata = {
    name: String(data.name).trim(),
    description: String(data.description).trim(),
    'allowed-tools': allowedTools,
    'when-to-use': data['when-to-use'] ? String(data['when-to-use']).trim() : undefined,
    model: data.model as any,
    'max-thinking-tokens': data['max-thinking-tokens'] ? Number(data['max-thinking-tokens']) : undefined,
    'disable-model-invocation': Boolean(data['disable-model-invocation']),
    'argument-hint': data['argument-hint'] ? String(data['argument-hint']).trim() : undefined,
    version: data.version ? String(data.version).trim() : undefined,
  }

  return {
    metadata,
    content: content.trim(),
    filePath,
    baseDir,
    locate,
  }
}

/**
 * 解析 allowed-tools 字段
 * 支持数组和空格分隔的字符串
 */
function parseAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    return trimmed.split(/\s+/).map(v => v.trim()).filter(Boolean)
  }
  return []
}

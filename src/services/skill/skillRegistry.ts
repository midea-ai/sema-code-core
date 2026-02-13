/**
 * Skill 注册表
 *
 * 管理 Skill 的全局注册和查找
 * 实现优先级：项目级 > 全局级
 */

import { Skill, SkillRegistry, SkillInfo } from '../../types/skill'
import { loadAllSkills } from './skillLoader'
import { logWarn } from '../../util/log'

/**
 * 全局 Skill 注册表
 */
let globalRegistry: SkillRegistry | null = null

/**
 * 初始化 Skill 注册表
 * 优先级：项目级 > 全局级
 * 如果有重名 Skill，项目级会覆盖全局级
 */
export function initializeSkillRegistry(workingDir: string): SkillRegistry {
  const registry: SkillRegistry = new Map()
  const skills = loadAllSkills(workingDir)

  for (const skill of skills) {
    const name = skill.metadata.name

    // 检查重复（后加载的会覆盖先加载的，由于 loadAllSkills 按项目->全局顺序加载，项目级会优先）
    if (registry.has(name)) {
      const existingSkill = registry.get(name)!
      logWarn(`Duplicate skill name detected: ${name}. Using ${skill.filePath} (override ${existingSkill.filePath})`)
    }

    registry.set(name, skill)
  }

  globalRegistry = registry
  return registry
}

/**
 * 获取 Skill 注册表
 */
export function getSkillRegistry(): SkillRegistry {
  if (!globalRegistry) {
    throw new Error('Skill registry not initialized. Call initializeSkillRegistry() first.')
  }
  return globalRegistry
}

/**
 * 根据名称查找 Skill
 */
export function findSkill(name: string): Skill | undefined {
  const registry = getSkillRegistry()
  return registry.get(name)
}

/**
 * 获取所有 Skills 的结构化信息
 */
export function getSkillsInfo(): SkillInfo[] {
  const registry = getSkillRegistry()
  const skillsInfo: SkillInfo[] = []

  for (const [name, skill] of registry.entries()) {
    skillsInfo.push({
      name,
      description: skill.metadata.description,
      locate: skill.locate
    })
  }

  return skillsInfo
}

/**
 * 获取所有 Skills 的简要信息（用于系统提示）
 */
export function getSkillsSummary(): string {
  const registry = getSkillRegistry()

  if (registry.size === 0) {
    return ''
  }

  const lines: string[] = ['', 'Available Skills:']

  for (const [name, skill] of registry.entries()) {
    const whenToUse = skill.metadata['when-to-use']
    const desc = whenToUse ? `${skill.metadata.description} (${whenToUse})` : skill.metadata.description
    lines.push(`- ${name}: ${desc}`)
  }

  lines.push('')
  lines.push('When a task requires specific domain knowledge or workflow, use the Skill tool to activate the relevant skill.')

  return lines.join('\n')
}

/**
 * 清除注册表缓存（用于测试）
 */
export function clearSkillRegistry(): void {
  globalRegistry = null
  // 清除 loadAllSkills 的缓存
  loadAllSkills.cache.clear?.()
}

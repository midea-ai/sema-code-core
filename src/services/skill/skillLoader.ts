/**
 * Skill 加载器
 *
 * 负责扫描目录、查找和加载 Skills
 * 支持项目级和全局级 Skills，项目级优先
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join, normalize, resolve } from 'path'
import { homedir } from 'os'
import { memoize } from 'lodash-es'
import { Skill } from '../../types/skill'
import { parseSkillFile } from './skillParser'
import { logDebug, logWarn } from '../../util/log'
import { normalizeSkillPath } from '../../util/file'

/**
 * 获取 Skill 搜索目录
 * 优先级：项目级 > 全局级
 */
export function getSkillSearchDirs(workingDir: string): string[] {
  // 先标准化 workingDir，然后再进行路径拼接
  const normalizedWorkingDir = normalizeSkillPath(workingDir)

  return [
    normalizeSkillPath(join(normalizedWorkingDir, '.sema', 'skills')),      // 项目级 Skills（优先）
    normalizeSkillPath(join(homedir(), '.sema', 'skills')),                 // 全局级 Skills
  ]
}

/**
 * 扫描单个目录，查找所有 Skill
 * @param dir 要扫描的目录
 * @param locate Skill 来源：'user' 或 'project'
 */
function scanSkillsInDir(dir: string, locate: 'user' | 'project'): Skill[] {
  if (!existsSync(dir)) {
    logDebug(`Skill directory does not exist: ${dir}`)
    return []
  }

  const skills: Skill[] = []

  try {
    const entries = readdirSync(dir)

    for (const entry of entries) {
      const fullPath = normalizeSkillPath(join(dir, entry))
      const stat = statSync(fullPath)

      if (stat.isDirectory()) {
        // 查找目录内的 SKILL.md 或 skill.md
        const skillFilePath = findSkillFile(fullPath)
        if (skillFilePath) {
          try {
            const skill = parseSkillFile(skillFilePath, fullPath, locate)
            skills.push(skill)
            logDebug(`Loaded skill: ${skill.metadata.name} from ${skillFilePath}`)
          } catch (error) {
            logWarn(`Failed to parse skill at ${skillFilePath}: ${error}`)
          }
        }
      } else if (entry.toLowerCase().endsWith('.md')) {
        // 直接是 .md 文件的 Skill
        try {
          const skill = parseSkillFile(fullPath, dir, locate)
          skills.push(skill)
          logDebug(`Loaded skill: ${skill.metadata.name} from ${fullPath}`)
        } catch (error) {
          logWarn(`Failed to parse skill at ${fullPath}: ${error}`)
        }
      }
    }
  } catch (error) {
    logWarn(`Failed to scan skill directory ${dir}: ${error}`)
  }

  return skills
}

/**
 * 在目录中查找 SKILL.md 或 skill.md
 */
function findSkillFile(dir: string): string | null {
  const candidates = ['SKILL.md', 'skill.md', 'Skill.md']

  for (const candidate of candidates) {
    const filePath = normalizeSkillPath(join(dir, candidate))
    if (existsSync(filePath)) {
      return filePath
    }
  }

  return null
}

/**
 * 加载所有 Skills（带缓存）
 */
export const loadAllSkills = memoize(
  (workingDir: string): Skill[] => {
    const searchDirs = getSkillSearchDirs(workingDir)
    const allSkills: Skill[] = []

    // 第一个目录是项目级，第二个是用户级（全局级）
    const locates: ('project' | 'user')[] = ['project', 'user']

    for (let i = 0; i < searchDirs.length; i++) {
      const dir = searchDirs[i]
      const locate = locates[i] || 'user' // 默认为 user
      const skills = scanSkillsInDir(dir, locate)
      allSkills.push(...skills)
    }

    logDebug(`Loaded ${allSkills.length} skills from ${searchDirs.length} directories`)
    return allSkills
  },
  // 缓存键：workingDir + 目录修改时间戳
  (workingDir: string) => {
    const searchDirs = getSkillSearchDirs(workingDir)
    const timestamps = searchDirs.map(dir => {
      try {
        if (existsSync(dir)) {
          return statSync(dir).mtimeMs
        }
      } catch {}
      return 0
    })
    return `${workingDir}:${timestamps.join(':')}`
  }
)

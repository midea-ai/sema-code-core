import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs'
import * as path from 'path'
import { getOriginalCwd } from '../../util/cwd'
import { getGlobalAgentMdPath } from '../../util/savePath'
import { getConfManager } from '../../manager/ConfManager'
import { getSkillTypesDescription } from '../skills/skillsManager'

/**
 * 读取全局 ~/.claude/CLAUDE.md
 */
function readGlobalAgentFile(): string {
  try {
    const agentPath = getGlobalAgentMdPath()
    // console.log('agentPath:', agentPath)
    if (fs.existsSync(agentPath)) {
      return fs.readFileSync(agentPath, 'utf8')
    }
    return ''
  } catch (error) {
    return ''
  }
}

/**
 * 从配置管理器中获取自定义的 customRules
 */
function readCustomRules(): string {
  try {
    const configManager = getConfManager()
    const coreConfig = configManager.getCoreConfig()
    return coreConfig?.customRules ?? ''
  } catch (error) {
    return ''
  }
}

/**
 * 生成 customRules 描述段
 */
function buildCustomRulesSection(): string {
  const customRules = readCustomRules()
  if (!customRules) return ''
  return `Custom rules (user-defined instructions):\n\n${customRules}`
}

/**
 * 读取当前目录下的项目配置文件
 * 优先读取 AGENTS.md，如果不存在则读取 CLAUDE.md
 * 返回 { content, filePath } 或 null
 */
function readProjectConfigFile(): { content: string; filePath: string } | null {
  try {
    const currentDir = getOriginalCwd()
    const agentPath = path.join(currentDir, 'AGENTS.md')
    const claudePath = path.join(currentDir, 'CLAUDE.md')

    if (fs.existsSync(agentPath)) {
      const content = fs.readFileSync(agentPath, 'utf8')
      if (content) return { content, filePath: agentPath }
    }

    if (fs.existsSync(claudePath)) {
      const content = fs.readFileSync(claudePath, 'utf8')
      if (content) return { content, filePath: claudePath }
    }

    return null
  } catch (error) {
    return null
  }
}

/**
 * 生成全局 agent 文件的描述段
 * 若文件不存在或内容为空则返回空字符串
 */
function buildGlobalAgentSection(globalContent: string): string {
  if (!globalContent) return ''
  return `Contents of ${getGlobalAgentMdPath()} (user's private global instructions for all projects):\n\n${globalContent}`
}

/**
 * 生成项目配置文件的描述段
 * 优先使用 AGENTS.md，没有才用 CLAUDE.md；若文件不存在或为空则返回空字符串
 */
function buildProjectConfigSection(): string {
  const result = readProjectConfigFile()
  if (!result) return ''
  return `Contents of ${result.filePath} (project instructions, checked into the codebase):\n\n${result.content}`
}

/**
 * 生成当前日期描述段
 */
function buildCurrentDateSection(): string {
  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10)
  return `# currentDate\nToday's date is ${dateStr}.`
}

/**
 * 生成 skills 相关的系统提醒信息
 */
export function generateSkillsReminder(): Anthropic.ContentBlockParam[] {
  const skillsDesc = getSkillTypesDescription()
  if (!skillsDesc) return []

  const reminder = `<system-reminder>\nThe following skills are available for use with the Skill tool:\n\n${skillsDesc}\n</system-reminder>`

  return [{
    type: 'text' as const,
    text: reminder
  }]
}

/**
 * 生成 rules 相关的系统提醒信息
 */
export function generateRulesReminders(): Anthropic.ContentBlockParam[] {
  const globalSection = buildGlobalAgentSection(readGlobalAgentFile())
  // console.log('globalSection:', globalSection)
  const projectSection = buildProjectConfigSection()
  const customRulesSection = buildCustomRulesSection()

  // 如果全局、项目配置和系统规则配置均为空，直接返回空数组
  if (!globalSection && !projectSection && !customRulesSection) {
    return []
  }

  const sections = [customRulesSection, globalSection, projectSection, buildCurrentDateSection()]
    .filter(Boolean)
    .join('\n\n')

  const rulesReminder = `<system-reminder>
As you answer the user's questions, you can use the following context:
# agentMd
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

${sections}

IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>`

  return [{
    type: 'text' as const,
    text: rulesReminder
  }]
}

import Anthropic from '@anthropic-ai/sdk'
import * as path from 'path'
import { getConfManager } from '../../manager/ConfManager'
import { getSkillTypesDescription } from '../skills/skillsManager'
import { getMemoryDescription } from '../memory/memManager'
import { getRuleDescription } from '../rules/rulesManager'
import { isFullReplaceMode } from './genSystemPrompt'
import { readInitialCwd } from '../../util/cwd'
import { PLAN_MODE_SYSTEM_REMINDER_PROMPT } from '../../prompt/plan'
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from '../../prompt/define'
import { SKILL_CONTEXT_NOTICE } from '../../prompt/compact'
import { getSkillsManager } from '../skills/skillsManager'
import { logError } from '../../util/log'

export async function generateSkillsReminder(): Promise<Anthropic.ContentBlockParam[]> {
  const skillsDesc = await getSkillTypesDescription()
  if (!skillsDesc) return []

  const reminder = `${REMINDER_SYS_OPEN}\nAvailable skills (invoke via the skill tool):\n\n${skillsDesc}\n${REMINDER_SYS_CLOSE}`

  return [{
    type: 'text' as const,
    text: reminder
  }]
}

export function generateRulesReminders(): Anthropic.ContentBlockParam[] {
  const configManager = getConfManager()
  const customRules = configManager.getCoreConfig()?.customRules ?? ''
  const customRulesSection = customRules ? `Custom rules (user-defined instructions):\n\n${customRules}` : ''
  const ruleSection = getRuleDescription()
  // replaceAll 模式下系统提示词已无 memory 说明，reminder 也不再注入 MEMORY.md 内容
  const memorySection = isFullReplaceMode() ? '' : getMemoryDescription()

  if (!customRulesSection && !ruleSection && !memorySection) {
    return []
  }

  const dateStr = new Date().toISOString().slice(0, 10)
  const sections = [customRulesSection, ruleSection, memorySection, `# Date\nCurrent date: ${dateStr}`]
    .filter(Boolean)
    .join('\n\n')

  const rulesReminder = `${REMINDER_SYS_OPEN}
The following session context should be applied when relevant — it takes precedence over default behavior.

${sections}
${REMINDER_SYS_CLOSE}`

  return [{
    type: 'text' as const,
    text: rulesReminder
  }]
}

/**
 * 压缩后注入的 reminder 块，顺序：被压掉的 skill 原文（仅作上下文，不受 hasSkillTool 门控）、
 * skill 列表（仅当会话有 skill 工具，与 handleControlSignalRebuild 同口径）、rules（始终）。
 * 压缩成功后历史已被摘要替换、不可逆，任何一段生成失败只降级不抛出。
 */
export async function generatePostCompactReminders(
  hasSkillTool: boolean,
  compactedSkills: Array<{ name: string; text: string }> = [],
): Promise<Anthropic.ContentBlockParam[]> {
  const reminders: Anthropic.ContentBlockParam[] = []

  if (compactedSkills.length > 0) {
    // 当前已禁用/已删除的 skill 不再注入（尊重用户当前配置）；状态查询失败则不过滤——
    // 内容仅作上下文且带禁止重执行提示，多注入无害，漏注入才是问题
    let activeSkills = compactedSkills
    try {
      const skillsManager = getSkillsManager()
      activeSkills = compactedSkills.filter(
        s => !!skillsManager.getSkillConfig(s.name) && !skillsManager.isSkillDisabled(s.name)
      )
    } catch (error) {
      logError(`[Compact] Failed to check skill status, injecting compacted skills unfiltered: ${error}`)
    }

    if (activeSkills.length > 0) {
      const sections = activeSkills.map(s => `### Skill: ${s.name}\n\n${s.text}`).join('\n\n')
      reminders.push({
        type: 'text' as const,
        text: `${REMINDER_SYS_OPEN}\n${SKILL_CONTEXT_NOTICE}\n\n${sections}\n${REMINDER_SYS_CLOSE}`,
      })
    }
  }

  if (hasSkillTool) {
    try {
      reminders.push(...await generateSkillsReminder())
    } catch (error) {
      logError(`[Compact] Failed to generate skills reminder after compact: ${error}`)
    }
  }

  try {
    reminders.push(...generateRulesReminders())
  } catch (error) {
    logError(`[Compact] Failed to generate rules reminder after compact: ${error}`)
  }

  return reminders
}

export function generatePlanReminders(): Anthropic.ContentBlockParam[] {
  const currentDir = readInitialCwd()
  const plansDir = path.join(currentDir, '.sema/', 'plans/')

  const rulesReminder = PLAN_MODE_SYSTEM_REMINDER_PROMPT(plansDir)

  return [{ type: 'text' as const, text: rulesReminder }]
}

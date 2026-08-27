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

export function generatePlanReminders(): Anthropic.ContentBlockParam[] {
  const currentDir = readInitialCwd()
  const plansDir = path.join(currentDir, '.sema/', 'plans/')

  const rulesReminder = PLAN_MODE_SYSTEM_REMINDER_PROMPT(plansDir)

  return [{ type: 'text' as const, text: rulesReminder }]
}

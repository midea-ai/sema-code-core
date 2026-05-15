import { z } from 'zod'
import { Tool } from './base/Tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/skill'
import { getSkillsManager } from '../services/skills/skillsManager'
import { TOOL_NAME_SKILL } from '../prompt/tool'

const TOOL_NAME = TOOL_NAME_SKILL
// 辅助函数：生成显示标题
function getTitle(input?: { skill?: string; args?: string }) {
  if (input?.skill) {
    const parts = [`skill: "${input.skill}"`]
    if (input.args) {
      parts.push(`args: "${input.args}"`)
    }
    return parts.join(', ')
  }
  return TOOL_NAME
}

const toolParams = z.strictObject({
  skill: z.string().describe('Name of the skill to invoke (e.g. "commit", "review-pr", "pdf")'),
  args: z.string().optional().describe('Extra arguments to pass to the skill, if any'),
})

type ToolRes = {
  name: string
  description: string
  systemPrompt: string  // skill 自身的系统提示（skillConfig.prompt 原文）
  filePath?: string
}

export const Skill = {
  name: TOOL_NAME,
  description() {
    return TOOL_DESCRIPTION
  },
  toolParams,
  isSafe() {
    return false
  },
  async validateInput({ skill }: z.infer<typeof toolParams>) {
    try {
      const skills = await getSkillsManager().getSkillsInfo()
      const found = skills.find(s => s.name === skill)

      if (!found) {
        const availableSkills = skills.map(s => s.name).join(', ')
        return {
          result: false,
          message: `No skill named "${skill}". Available: ${availableSkills || 'none'}.`,
        }
      }

      return { result: true }
    } catch (error) {
      return {
        result: false,
        message: `Skill system is not yet initialized: ${error}`,
      }
    }
  },
  genToolPermission({ skill }: z.infer<typeof toolParams>) {
    const skillConfig = getSkillsManager().getSkillConfig(skill)

    if (!skillConfig) {
      throw new Error(`No skill named "${skill}" was found.`)
    }

    return {
      title: skillConfig.name,
      content: skillConfig.prompt,
    }
  },
  genToolResultMessage({ name, description, systemPrompt, filePath }: ToolRes) {
    const title = name
    const summary = filePath ?? `Skill "${name}" is now active.`

    const preview = systemPrompt.length > 8000
      ? systemPrompt.substring(0, 8000) + '...'
      : systemPrompt
    const content = `${description}\n\n${preview}`

    return {
      title,
      summary,
      content,
    }
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  async *call({ skill, args }: z.infer<typeof toolParams>) {
    const skillConfig = getSkillsManager().getSkillConfig(skill)

    if (!skillConfig) {
      throw new Error(`No skill named "${skill}" was found.`)
    }

    const trimmedArgs = args?.trim()
    let textContent = skillConfig.prompt

    if (trimmedArgs) {
      if (textContent.includes('$ARGUMENTS')) {
        textContent = textContent.replaceAll('$ARGUMENTS', trimmedArgs)
      } else {
        textContent = `${textContent}\n\nARGUMENTS: ${trimmedArgs}`
      }
    }

    const text = skillConfig.filePath
      ? `Skill’s base path: ${skillConfig.filePath}\n\n${textContent}`
      : textContent

    const output: ToolRes = {
      name: skillConfig.name,
      description: skillConfig.description,
      systemPrompt: skillConfig.prompt,
      filePath: skillConfig.filePath,
    }

    yield {
      type: 'result' as const,
      resultForAssistant: this.genResultForAssistant(output),
      data: output,
      additionalBlocks: [{ type: 'text' as const, text }],
    }
  },
  genResultForAssistant(output: ToolRes): string {
    return `Activating skill: ${output.name}`
  },
} satisfies Tool<typeof toolParams, ToolRes>

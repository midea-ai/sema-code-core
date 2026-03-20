import { z } from 'zod'
import { Tool } from '../base/Tool'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'
import { getSkillsManager } from '../../services/skills/skillsManager'

// 辅助函数：生成显示标题
function getTitle(input?: { skill?: string; args?: string }) {
  if (input?.skill) {
    const parts = [`skill: "${input.skill}"`]
    if (input.args) {
      parts.push(`args: "${input.args}"`)
    }
    return parts.join(', ')
  }
  return TOOL_NAME_FOR_PROMPT
}

const inputSchema = z.strictObject({
  skill: z.string().describe('The skill name. E.g., "commit", "review-pr", or "pdf"'),
  args: z.string().optional().describe('Optional arguments for the skill'),
})

type Output = {
  name: string
  description: string
  systemPrompt: string  // skill 自身的系统提示（skillConfig.prompt 原文）
}

export const SkillTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  async validateInput({ skill }: z.infer<typeof inputSchema>) {
    try {
      const skills = await getSkillsManager().getSkillsInfo()
      const found = skills.find(s => s.name === skill)

      if (!found) {
        const availableSkills = skills.map(s => s.name).join(', ')
        return {
          result: false,
          message: `Skill "${skill}" not found. Available skills: ${availableSkills || 'none'}`,
        }
      }

      return { result: true }
    } catch (error) {
      return {
        result: false,
        message: `Skill system not initialized: ${error}`,
      }
    }
  },
  genToolPermission({ skill }: z.infer<typeof inputSchema>) {
    const skillConfig = getSkillsManager().getSkillConfig(skill)

    if (!skillConfig) {
      throw new Error(`Skill "${skill}" not found`)
    }

    return {
      title: skillConfig.name,
      content: skillConfig.prompt,
    }
  },
  genToolResultMessage({ name, description, systemPrompt }: Output) {
    const title = name
    const summary = `Skill "${name}" loaded successfully`

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
  async *call({ skill, args }: z.infer<typeof inputSchema>) {
    const skillConfig = getSkillsManager().getSkillConfig(skill)

    if (!skillConfig) {
      throw new Error(`Skill "${skill}" not found`)
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
      ? `Base directory for this skill: ${skillConfig.filePath}\n\n${textContent}`
      : textContent

    const output: Output = {
      name: skillConfig.name,
      description: skillConfig.description,
      systemPrompt: skillConfig.prompt,
    }

    yield {
      type: 'result' as const,
      resultForAssistant: this.genResultForAssistant(output),
      data: output,
      additionalBlocks: [{ type: 'text' as const, text }],
    }
  },
  genResultForAssistant(output: Output): string {
    return `Launching skill: ${output.name}`
  },
} satisfies Tool<typeof inputSchema, Output>

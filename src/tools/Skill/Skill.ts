import { z } from 'zod'
import { Tool } from '../base/Tool'
import { findSkill, getSkillRegistry } from '../../services/skill/skillRegistry'
import { normalizeSkillPath } from '../../util/file'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'

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
  skillName: string
  skillContent: string
  allowedTools: string[]
  baseDir: string
  skill?: string
  args?: string
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
      const skillObj = findSkill(skill)

      if (!skillObj) {
        const registry = getSkillRegistry()
        const availableSkills = Array.from(registry.keys()).join(', ')
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
  genToolPermission({ skill, args }: z.infer<typeof inputSchema>) {
    const skillObj = findSkill(skill)

    if (!skillObj) {
      throw new Error(`Skill "${skill}" not found`)
    }

    const title = skillObj.metadata.name
    const content = skillObj.metadata.description

    return {
      title,
      content,
    }
  },
  genToolResultMessage({ skillName, skillContent, allowedTools, baseDir }) {
    const title = skillName
    const summary = `Skill "${skillName}" loaded successfully`

    let content = `Base directory: ${normalizeSkillPath(baseDir)}\n\n`

    if (allowedTools && allowedTools.length > 0) {
      content += `Recommended tools: ${allowedTools.join(', ')}\n\n`
    }

    // 显示技能内容的前500个字符
    const preview = skillContent.length > 500
      ? skillContent.substring(0, 500) + '...'
      : skillContent
    content += preview

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
    const skillObj = findSkill(skill)

    if (!skillObj) {
      throw new Error(`Skill "${skill}" not found`)
    }

    // 处理参数替换
    let content = skillObj.content
    const trimmedArgs = args?.trim()

    if (trimmedArgs) {
      if (content.includes('$ARGUMENTS')) {
        content = content.replaceAll('$ARGUMENTS', trimmedArgs)
      } else {
        content = `${content}\n\nARGUMENTS: ${trimmedArgs}`
      }
    }

    const output: Output = {
      skillName: skillObj.metadata.name,
      skillContent: content,
      allowedTools: skillObj.metadata['allowed-tools'] || [],
      baseDir: normalizeSkillPath(skillObj.baseDir),
      skill,
      args,
    }

    const resultForAssistant = this.genResultForAssistant(output)

    yield {
      type: 'result',
      resultForAssistant: resultForAssistant,
      data: output,
    }
  },
  genResultForAssistant(output: Output): string {
    const { skillContent, allowedTools, baseDir, args } = output

    let result = `# Skill Activated: ${output.skillName}\n\n`
    result += `Base directory for this skill: ${normalizeSkillPath(baseDir)}\n\n`

    // 添加参数信息（如果有）
    if (args) {
      result += `Arguments: ${args}\n\n`
    }

    result += `${skillContent}\n`

    // 注入 Allowed Tools 软约束
    if (allowedTools && allowedTools.length > 0) {
      result += `\n---\n\n`
      result += `<system-reminder>\n`
      result += `While working on this skill, you should prioritize using the following tools: ${allowedTools.join(', ')}.\n`
      result += `These tools are recommended for this skill's workflow. You may use other tools if absolutely necessary.\n`
      result += `</system-reminder>\n`
    }

    // 添加引导性文本，确保模型继续执行任务
    result += `\n---\n\n`
    result += `Now that you have loaded the skill instructions, please proceed with the task based on the guidelines above.`
    if (args) {
      result += ` Remember to process the provided arguments: ${args}`
    }

    return result
  },
} satisfies Tool<typeof inputSchema, Output>

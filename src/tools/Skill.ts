import { z } from 'zod'
import * as path from 'path'
import { Tool } from './base/Tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/skill'
import { getSkillsManager, normalizeSkillFilePath } from '../services/skills/skillsManager'
import { TOOL_NAME_SKILL } from '../prompt/tool'
import type { SkillConfig } from '../types/skill'

const TOOL_NAME = TOOL_NAME_SKILL
// 辅助函数：生成显示标题
function getTitle(input?: { skill?: string; args?: string; file?: string }) {
  if (input?.skill) {
    const parts = [`skill: "${input.skill}"`]
    if (input.args) {
      parts.push(`args: "${input.args}"`)
    }
    if (input.file) {
      parts.push(`file: "${input.file}"`)
    }
    return parts.join(', ')
  }
  return TOOL_NAME
}

const toolParams = z.strictObject({
  skill: z.string().describe('Name of the skill to invoke (e.g. "commit", "review-pr", "pdf")'),
  args: z.string().optional().describe('Extra arguments to pass to the skill, if any'),
  file: z.string().optional().describe('Relative path of a text file bundled with the skill; returns that file in full instead of activating the skill'),
})

type ToolRes = {
  name: string
  description: string
  systemPrompt: string  // skill 自身的系统提示（skillConfig.prompt 原文）；内联 skill 为 ''
  filePath?: string
  private?: boolean     // 内联 skill：事件里只给描述，不给正文
  file?: string         // 读子文件时的相对路径
}

/** 内联 skill 的子文件内容；不存在返回 undefined */
function readBundledFile(skillConfig: SkillConfig, file: string): string | undefined {
  return skillConfig.files?.[normalizeSkillFilePath(file)]
}

/** 激活内联 skill 时的说明：子文件走本工具的 file 参数，脚本与资源按资源目录解析 */
function privateSkillHeader(skillConfig: SkillConfig): string {
  const filesLine = 'Text files named in these instructions are read with this tool\'s file parameter.'
  if (!skillConfig.resourceDir) return filesLine
  return `Skill’s resource path: ${skillConfig.resourceDir}\n${filesLine} Scripts and other resources resolve against the resource path above.`
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
  async validateInput({ skill, file }: z.infer<typeof toolParams>) {
    try {
      // 禁用的 skill 对模型不可见也不可调用
      const skills = (await getSkillsManager().getSkillsInfo()).filter(s => s.status !== false)
      const found = skills.find(s => s.name === skill)

      if (!found) {
        const availableSkills = skills.map(s => s.name).join(', ')
        return {
          result: false,
          message: `No skill named "${skill}". Available: ${availableSkills || 'none'}.`,
        }
      }

      if (file) {
        const skillConfig = getSkillsManager().getSkillConfig(skill)
        if (!skillConfig?.private) {
          const base = skillConfig?.filePath ? ` under ${path.dirname(skillConfig.filePath)}` : ''
          return { result: false, message: `Skill "${skill}" keeps its files on disk${base}.` }
        }
        if (readBundledFile(skillConfig, file) === undefined) {
          const available = Object.keys(skillConfig.files ?? {}).join(', ')
          return { result: false, message: `Skill "${skill}" has no file "${file}". Available: ${available || 'none'}.` }
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
  genToolPermission({ skill, file }: z.infer<typeof toolParams>) {
    const skillConfig = getSkillsManager().getSkillConfig(skill)

    if (!skillConfig) {
      throw new Error(`No skill named "${skill}" was found.`)
    }

    // 内联 skill 的正文不出界面：权限请求只给描述；读子文件时给文件名
    return {
      title: skillConfig.name,
      content: file ? file : (skillConfig.private ? skillConfig.description : skillConfig.prompt),
    }
  },
  genToolResultMessage({ name, description, systemPrompt, filePath, private: isPrivate, file }: ToolRes) {
    const title = name
    if (file) {
      return { title, summary: file, content: '' }
    }
    const summary = filePath ?? `Skill "${name}" is now active.`
    if (isPrivate) {
      return { title, summary, content: description }
    }

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
  async *call({ skill, args, file }: z.infer<typeof toolParams>) {
    const skillConfig = getSkillsManager().getSkillConfig(skill)

    if (!skillConfig || getSkillsManager().isSkillDisabled(skill)) {
      throw new Error(`No skill named "${skill}" was found.`)
    }

    // 读内联 skill 的文本子文件：整个文件返回，不激活 skill
    if (file) {
      const content = skillConfig.private ? readBundledFile(skillConfig, file) : undefined
      if (content === undefined) {
        throw new Error(`Skill "${skill}" has no file "${file}".`)
      }
      const output: ToolRes = {
        name: skillConfig.name,
        description: skillConfig.description,
        systemPrompt: '',
        private: true,
        file: normalizeSkillFilePath(file),
      }
      yield {
        type: 'result' as const,
        resultForAssistant: content,
        data: output,
      }
      return
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

    // 目录 skill：注入目录而非 SKILL.md 文件路径，并声明正文已完整，避免模型再读一遍 SKILL.md
    // 内联 skill：磁盘上没有文件，说明子文件与资源各走哪条路
    let text: string
    if (skillConfig.private) {
      text = `${privateSkillHeader(skillConfig)}\nThe full body of SKILL.md is reproduced below.\n\n${textContent}`
    } else if (skillConfig.filePath) {
      text = `Skill’s base path: ${path.dirname(skillConfig.filePath)}\n` +
        'The full body of SKILL.md is reproduced below — do not read SKILL.md, you already have it. ' +
        'Resolve every relative path in these instructions against the base path above.' +
        `\n\n${textContent}`
    } else {
      text = textContent
    }

    const output: ToolRes = {
      name: skillConfig.name,
      description: skillConfig.description,
      systemPrompt: skillConfig.private ? '' : skillConfig.prompt,
      filePath: skillConfig.filePath,
      ...(skillConfig.private ? { private: true } : {}),
    }

    yield {
      type: 'result' as const,
      resultForAssistant: this.genResultForAssistant(output),
      data: output,
      additionalBlocks: [{ type: 'text' as const, text }],
    }
  },
  genResultForAssistant(output: ToolRes): string {
    if (output.file) return ''
    return `Skill "${output.name}" activated; its full instructions are provided below.`
  },
} satisfies Tool<typeof toolParams, ToolRes>

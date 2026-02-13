import Anthropic from '@anthropic-ai/sdk'
import * as fs from 'fs'
import * as path from 'path'
import { getOriginalCwd } from './cwd'
import { PROJECT_FILE } from '../constants/product'
import { getGlobalAgentMdPath } from '../util/savePath'
import { getConfManager } from '../manager/ConfManager'

/**
 * 读取当前目录下的配置文件内容
 * 优先读取 AGENT.md，如果不存在则读取 CLAUDE.md
 */
function readConfigFile(): string {
  try {
    const currentDir = getOriginalCwd()
    const agentPath = path.join(currentDir, PROJECT_FILE)
    const claudePath = path.join(currentDir, 'CLAUDE.md')

    if (fs.existsSync(agentPath)) {
      return fs.readFileSync(agentPath, 'utf8')
    }

    if (fs.existsSync(claudePath)) {
      return fs.readFileSync(claudePath, 'utf8')
    }

    return ''
  } catch (error) {
    return ''
  }
}

/**
 * 读取全局~/.sema/AGENT.md 加上customRules
 */
function readGlobalAgentFile(): string {
  try {
    const agentPath = getGlobalAgentMdPath()
    let content = ''

    if (fs.existsSync(agentPath)) {
      content = fs.readFileSync(agentPath, 'utf8')
    }

    // 尝试从配置管理器中获取自定义的 customRules
    const configManager = getConfManager()
    const coreConfig = configManager.getCoreConfig()

    if (coreConfig?.customRules) {
      content = content ? `${content}\n\n${coreConfig.customRules}` : coreConfig.customRules
    }

    return content
  } catch (error) {
    return ''
  }
}

/**
 * 生成 rules 相关的系统提醒信息
 */
export function generateRulesReminders(): Anthropic.ContentBlockParam[] {
  const globalContent = readGlobalAgentFile()
  const projectContent = readConfigFile()

  // 如果全局和项目配置都为空，直接返回空数组
  if (!globalContent && !projectContent) {
    return []
  }

  const rulesReminder = `<system-reminder>
As you answer the user's questions, you can use the following context:
# agentMd
Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

Contents of ${getGlobalAgentMdPath()} (user's private global instructions for all projects): ${globalContent}

${projectContent}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>`

  return [{
    type: 'text' as const,
    text: rulesReminder
  }]
}
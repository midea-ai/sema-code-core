import { EOL } from 'os'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod'
import { Tool, ValidationResult } from '../base/Tool'
import { splitCommand } from '../../util/commands'
import { isInDirectory } from '../../util/file'
import { PersistentShell } from '../../util/shell'
import { getCwd, getOriginalCwd } from '../../util/cwd'
import { processHeredocCommand } from '../../util/format'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from './prompt'
import { formatOutput } from './utils'
import { getEventBus } from '../../events/EventSystem'
import type { ToolExecutionChunkData } from '../../events/types'
import { MAIN_AGENT_ID } from '../../manager/StateManager'
import { INTERRUPT_MESSAGE_FOR_TOOL_USE } from '../../constants/message'


const BANNED_COMMANDS = [
  'alias',
  'curl',
  'curlie',
  'wget',
  'axel',
  'aria2c',
  'nc',
  'telnet',
  'lynx',
  'w3m',
  'links',
  'httpie',
  'xh',
  'http-prompt',
  'chrome',
  'firefox',
  'safari',
]

// 辅助函数：生成显示标题
function getTitle(input?: { command?: string }) {
  if (input?.command) {
    const content = processHeredocCommand(input.command)
    return `${content}`
  }
  return TOOL_NAME_FOR_PROMPT
}

export const inputSchema = z.strictObject({
  command: z.string().describe('The command to execute'),
  timeout: z
    .number()
    .optional()
    .describe(`Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS})`),
  description: z.string().describe(`Clear, concise description of what this command does in 5-10 words, in active voice. Examples:
Input: ls
Output: List files in current directory

Input: git status
Output: Show working tree status

Input: npm install
Output: Install package dependencies

Input: mkdir foo
Output: Create directory 'foo'`)
})

type In = typeof inputSchema
export type Out = {
  stdout: string
  stdoutLines: number 
  stderr: string
  stderrLines: number 
  interrupted: boolean
  command?: string
}

export const BashTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  isReadOnly() {
    return false
  },
  supportsInterrupt() {
    return true
  },
  inputSchema,
  async validateInput({ command }, agentContext: any): Promise<ValidationResult> {
    const commands = splitCommand(command)
    for (const cmd of commands) {
      const parts = cmd.split(' ')
      const baseCmd = parts[0]

      if (baseCmd && BANNED_COMMANDS.includes(baseCmd.toLowerCase())) {
        return {
          result: false,
          message: `Command '${baseCmd}' is not allowed for security reasons`,
        }
      }

      if (baseCmd === 'cd' && parts[1]) {
        const targetDir = parts[1]!.replace(/^['"]|['"]$/g, '') 
        const fullTargetDir = isAbsolute(targetDir)
          ? targetDir
          : resolve(getCwd(), targetDir)
        if (
          !isInDirectory(
            relative(getOriginalCwd(), fullTargetDir),
            relative(getCwd(), getOriginalCwd()),
          )
        ) {
          return {
            result: false,
            message: `ERROR: cd to '${fullTargetDir}' was blocked. For security, agent may only change directories to child directories of the original working directory (${getOriginalCwd()}) for this session.`,
          }
        }
      }
    }

    return { result: true }
  },
  genToolPermission(input) {
    const title = getTitle(input)
    return {
      title,
      content: input.description 
    }
  },
  genToolResultMessage({ stdout, stderr, interrupted, command }) {
    let result = ''

    if (stdout !== '') {
      result += formatOutput(stdout.trim()).truncatedContent + '\n'
    }

    if (stderr !== '') {
      result += formatOutput(stderr.trim()).truncatedContent + '\n'
    }

    if (stdout === '' && stderr === '') {
      result = '(No content)'
    }

    const title = command || ''

    return {
      title,
      summary: '',
      content: result.trim()
    }
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  genResultForAssistant({ interrupted, stdout, stderr }): string {
    const headTailLines = 500
    const { truncatedContent: stdoutContent } = stdout.trim()
      ? formatOutput(stdout.trim(), headTailLines)
      : { truncatedContent: '' }
    const { truncatedContent: stderrContent } = stderr.trim()
      ? formatOutput(stderr.trim(), headTailLines)
      : { truncatedContent: '' }

    if (interrupted) {
      const errorMsg = stderrContent
      return stdoutContent
        ? `${errorMsg}\n${INTERRUPT_MESSAGE_FOR_TOOL_USE}\n${stdoutContent}`
        : `${errorMsg}`
    }

    const hasBoth = stdoutContent && stderrContent
    const result = `${stdoutContent}${hasBoth ? '\n' : ''}${stderrContent}`
    return result || '(no content)'
  },
  async *call(
    { command, timeout = DEFAULT_TIMEOUT_MS },
    agentContext: any,
  ) {
    let stdout = ''
    let stderr = ''
    const abortController = agentContext.abortController

    if (abortController?.signal.aborted) {
      const data: Out = {
        stdout: '',
        stdoutLines: 0,
        stderr: 'Command cancelled before execution',
        stderrLines: 1,
        interrupted: true,
        command,
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    // 确保不超过最大超时限制
    const effectiveTimeout = Math.min(timeout, MAX_TIMEOUT_MS)

    // 与 genToolResultMessage 保持一致的 title 计算逻辑
    let commandDisplay = command || ''

    // 流式输出回调：格式与 genToolResultMessage 一致，仅在有内容变化时触发
    // chunk 的 '' 不需要 转为 (no content)
    const isMainAgent = agentContext.agentId === MAIN_AGENT_ID
    const onChunk = isMainAgent ? (chunkStdout: string, chunkStderr: string) => {
      let content = ''
      if (chunkStdout.trim()) content += formatOutput(chunkStdout.trim()).truncatedContent
      if (chunkStderr.trim()) content += (content ? '\n' : '') + formatOutput(chunkStderr.trim()).truncatedContent

      const chunkData: ToolExecutionChunkData = {
        agentId: agentContext.agentId,
        toolId: agentContext.currentToolUseID || '',
        toolName: TOOL_NAME_FOR_PROMPT,
        title: commandDisplay,
        summary: '',
        content: content,
      }
      getEventBus().emit('tool:execution:chunk', chunkData)
    } : undefined

    try {
      const result = await PersistentShell.getInstance().exec(
        command,
        abortController?.signal,
        effectiveTimeout,
        onChunk,
      )
      stdout += (result.stdout || '').trim() + EOL
      if (result.code !== 0) {
        stderr += `Exit code ${result.code}` + EOL
      }
      stderr += (result.stderr || '').trim() + EOL

      const stdoutTrimmed = stdout.trim()
      const stderrTrimmed = stderr.trim()
      const { totalLines: stdoutLines, truncatedContent: stdoutContent } =
        stdoutTrimmed ? formatOutput(stdoutTrimmed) : { totalLines: 0, truncatedContent: '' }
      const { totalLines: stderrLines, truncatedContent: stderrContent } =
        stderrTrimmed ? formatOutput(stderrTrimmed) : { totalLines: 0, truncatedContent: '' }

      const data: Out = {
        stdout: stdoutContent,
        stdoutLines,
        stderr: stderrContent,
        stderrLines,
        interrupted: result.interrupted,
        command,
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
    } catch (error) {
      const isAborted = abortController?.signal.aborted ?? false
      const errorMessage = isAborted
        ? 'Command was cancelled by user'
        : `Command failed: ${error instanceof Error ? error.message : String(error)}`

      const { totalLines: stdoutLines, truncatedContent: stdoutContent } = formatOutput(stdout.trim())
      const data: Out = {
        stdout: stdoutContent,
        stdoutLines,
        stderr: errorMessage,
        stderrLines: 1,
        interrupted: isAborted,
        command,
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
    }
  },
} satisfies Tool<In, Out>
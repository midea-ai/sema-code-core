import { EOL } from 'os'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod'
import { Tool, ValidationResult } from '../base/Tool'
import { splitCommand } from '../../util/commands'
import { isInDirectory } from '../../util/file'
import { PersistentShell } from '../../util/shell'
import { getCwd, getOriginalCwd } from '../../util/cwd'
import { processHeredocCommand } from '../../util/format'
import { BANNED_COMMANDS, DESCRIPTION, MAX_RENDERED_LINES, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, TOOL_NAME_FOR_PROMPT } from './prompt'
import { formatOutput } from './utils'

const MAX_COMMAND_TITLE_LENGTH = 300

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
  genToolResultMessage({ stdout, stdoutLines, stderr, stderrLines, interrupted, command }) {

    function genTruncatedContent(content: string, totalLines: number): string {
      const allLines = content.split('\n')
      if (allLines.length <= MAX_RENDERED_LINES) {
        return allLines.join('\n')
      }

      const lastLines = allLines.slice(-MAX_RENDERED_LINES)
      return [
        `Showing last ${MAX_RENDERED_LINES} lines of ${totalLines} total lines`,
        ...lastLines,
      ].join('\n')
    }

    let result = ''

    if (stdout !== '') {
      const formattedContent = genTruncatedContent(stdout.trim(), stdoutLines)
      result += formattedContent + '\n'
    }

    if (stderr !== '') {
      const formattedContent = genTruncatedContent(stderr.trim(), stderrLines)
      result += formattedContent + '\n'
    }

    if (stdout === '' && stderr === '') {
      result = '(No content)'
    }

    let commandDisplay = command || ''
    if (commandDisplay.length > MAX_COMMAND_TITLE_LENGTH) {
      commandDisplay = commandDisplay.substring(0, MAX_COMMAND_TITLE_LENGTH - 3) + '...'
    }
    const title = `${commandDisplay}`

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
    let errorMessage = stderr.trim()
    if (interrupted) {
      if (stderr) errorMessage += EOL
      errorMessage += '<error>Command was aborted before completion</error>'
    }
    const hasBoth = stdout.trim() && errorMessage
    return `${stdout.trim()}${hasBoth ? '\n' : ''}${errorMessage.trim()}`
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

    try {
      const result = await PersistentShell.getInstance().exec(
        command,
        abortController?.signal,
        timeout,
      )
      stdout += (result.stdout || '').trim() + EOL
      stderr += (result.stderr || '').trim() + EOL
      if (result.code !== 0) {
        stderr += `Exit code ${result.code}`
      }

      if (!isInDirectory(getCwd(), getOriginalCwd())) {
        await PersistentShell.getInstance().setCwd(getOriginalCwd())
        stderr = `${stderr.trim()}${EOL}Shell cwd was reset to ${getOriginalCwd()}`

      }

      const { totalLines: stdoutLines, truncatedContent: stdoutContent } =
        formatOutput(stdout.trim())
      const { totalLines: stderrLines, truncatedContent: stderrContent } =
        formatOutput(stderr.trim())

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

      const data: Out = {
        stdout: stdout.trim(),
        stdoutLines: stdout.split('\n').length,
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
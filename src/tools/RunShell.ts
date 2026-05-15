import { EOL } from 'os'
import { isAbsolute, relative, resolve } from 'path'
import { z } from 'zod'
import { Tool, ValidationResult } from './base/Tool'
import { splitCommand } from '../util/commands'
import { isInDirectory } from '../util/file'
import { PersistentShell, humanizeDuration, type TimeoutTransferContext } from '../util/shell'
import { getTaskManager } from '../manager/TaskManager'
import { readInitialCwd } from '../util/cwd'
import { TOOL_NAME_RUN_SHELL, TOOL_NAME_PEEK_BG_JOB } from '../prompt/tool'
import { getToolDescription } from '../prompt/tools/runShell'
import { getConfManager } from '../manager/ConfManager'
import { formatOutput, STDOUT_HEAD_TAIL_LINES, STDERR_HEAD_TAIL_LINES } from '../util/shell'
import { getEventBus } from '../events/EventSystem'
import type { ToolExecutionChunkData } from '../events/types'
import { MAIN_AGENT_ID } from '../manager/StateManager'
import { TOOL_INTERRUPT_MSG } from '../util/message'

export const RUN_SHELL_MAX_TIMEOUT_MS = 600000; // 最大超时毫秒数 10分钟
export const DEFAULT_RUN_SHELL_TIMEOUT_MS = 120000; // 默认超时毫秒数 2分钟

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
    return input.command
  }
  return TOOL_NAME_RUN_SHELL
}

export const toolParams = z.strictObject({
  command: z.string().describe('The shell command to run'),
  timeout: z
    .number()
    .optional()
    .describe(`Timeout duration in milliseconds, up to ${RUN_SHELL_MAX_TIMEOUT_MS}ms (${RUN_SHELL_MAX_TIMEOUT_MS / 60000} min). Defaults to ${DEFAULT_RUN_SHELL_TIMEOUT_MS}ms if omitted.`),
  description: z.string().optional().describe(`A brief active-voice summary (5-10 words) explaining what this command does. Keep it simple for common commands, add context for complex ones.

Examples:
  pwd → "Print current working directory"
  git log --oneline -5 → "Show last 5 commits"
  docker ps → "List running containers"
  cat .env | wc -l → "Count lines in .env file"
  tar -czf backup.tar.gz src/ → "Compress src directory into tarball"`),
  background: z
    .boolean()
    .optional()
    .describe(`When true, the command runs as a background task. Retrieve its output later via ${TOOL_NAME_PEEK_BG_JOB}.`),
})

type In = typeof toolParams
export type ToolOut = {
  stdout: string
  stdoutLines: number 
  stderr: string
  stderrLines: number 
  interrupted: boolean
  command?: string
}

export const RunShell = {
  name: TOOL_NAME_RUN_SHELL,
  description() {
    return getToolDescription(DEFAULT_RUN_SHELL_TIMEOUT_MS, RUN_SHELL_MAX_TIMEOUT_MS)
  },
  isSafe() {
    return false
  },
  supportsInterrupt() {
    return true
  },
  toolParams,
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
          : resolve(readInitialCwd(), targetDir)
        if (
          !isInDirectory(
            relative(readInitialCwd(), fullTargetDir),
            relative(readInitialCwd(), readInitialCwd()),
          )
        ) {
          return {
            result: false,
            message: `ERROR: cd to '${fullTargetDir}' was blocked. For security, agent may only change directories to child directories of the original working directory (${readInitialCwd()}) for this session.`,
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
      content: input.description || ''
    }
  },
  genToolResultMessage({ stdout, stderr, interrupted, command }) {
    let result = ''

    if (stdout !== '') {
      result += formatOutput(stdout.trim(), STDOUT_HEAD_TAIL_LINES).truncatedContent + '\n'
    }

    if (stderr !== '') {
      result += formatOutput(stderr.trim(), STDERR_HEAD_TAIL_LINES).truncatedContent + '\n'
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
    const { truncatedContent: stdoutContent } = stdout.trim()
      ? formatOutput(stdout.trim(), STDOUT_HEAD_TAIL_LINES)
      : { truncatedContent: '' }
    const { truncatedContent: stderrContent } = stderr.trim()
      ? formatOutput(stderr.trim(), STDERR_HEAD_TAIL_LINES)
      : { truncatedContent: '' }

    if (interrupted) {
      const parts = [stdoutContent, TOOL_INTERRUPT_MSG, stderrContent].filter(Boolean)
      return parts.join('\n')
    }

    const hasBoth = stdoutContent && stderrContent
    const result = `${stdoutContent}${hasBoth ? '\n' : ''}${stderrContent}`
    return result || '(no content)'
  },
  async *call(
    { command, timeout = DEFAULT_RUN_SHELL_TIMEOUT_MS, background },
    agentContext: any,
  ) {
    const abortController = agentContext.abortController

    // 子代理不支持后台执行，强制前台
    const isSubAgent = agentContext.agentId !== MAIN_AGENT_ID
    const disableBackground = getConfManager().getCoreConfig()?.disableBackgroundTasks ?? false

    // ① background=true → 直接 spawn 独立进程（仅主代理，且未禁用后台任务）
    if (background && !isSubAgent && !disableBackground) {
      try {
        const { taskId, filepath } = getTaskManager().spawnRunShellTask(
          command,
          agentContext.currentToolUseID || '',
          agentContext,
        )
        const msg = `Command running in background. Task ID: ${taskId}. Output: ${filepath}`
        const data: ToolOut = {
          stdout: msg,
          stdoutLines: 1,
          stderr: '',
          stderrLines: 0,
          interrupted: false,
          command,
        }
        yield { type: 'result', data, resultForAssistant: msg }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        const data: ToolOut = {
          stdout: '',
          stdoutLines: 0,
          stderr: errMsg,
          stderrLines: 1,
          interrupted: false,
          command,
        }
        yield { type: 'result', data, resultForAssistant: errMsg }
      }
      return
    }

    let stdout = ''
    let stderr = ''

    if (abortController?.signal.aborted) {
      const data: ToolOut = {
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
    const effectiveTimeout = Math.min(timeout, RUN_SHELL_MAX_TIMEOUT_MS)

    // 与 genToolResultMessage 保持一致的 title 计算逻辑
    let commandDisplay = command || ''

    // 流式输出回调：格式与 genToolResultMessage 一致，仅在有内容变化时触发
    // chunk 的 '' 不需要 转为 (no content)
    const isMainAgent = agentContext.agentId === MAIN_AGENT_ID
    const onChunk = isMainAgent ? (chunkStdout: string, chunkStderr: string) => {
      let content = ''
      if (chunkStdout.trim()) content += formatOutput(chunkStdout.trim(), undefined, { resolveCR: false }).truncatedContent
      if (chunkStderr.trim()) content += (content ? '\n' : '') + formatOutput(chunkStderr.trim(), undefined, { resolveCR: false }).truncatedContent

      const chunkData: ToolExecutionChunkData = {
        agentId: agentContext.agentId,
        toolId: agentContext.currentToolUseID || '',
        toolName: TOOL_NAME_RUN_SHELL,
        title: commandDisplay,
        summary: '',
        content: content,
      }
      getEventBus().emit('tool:execution:chunk', chunkData)
    } : undefined

    // ② 超时接管回调（子代理不接管，超时直接 kill；禁用后台任务时同样直接 kill）
    let bgTaskId: string | undefined
    let bgFilepath: string | undefined
    const onTimeout = (isSubAgent || disableBackground) ? undefined : (ctx: TimeoutTransferContext) => {
      const result = getTaskManager().takeoverTask(
        ctx,
        command,
        agentContext.currentToolUseID || '',
        agentContext,
      )
      bgTaskId = result.taskId
      bgFilepath = result.filepath
    }

    try {
      const result = await PersistentShell.getInstance().exec(
        command,
        abortController?.signal,
        effectiveTimeout,
        onChunk,
        onTimeout,
      )

      // ③ 超时接管标记（code === -1）
      if (result.code === -1 && bgTaskId) {
        const msg = `Command timed out after ${humanizeDuration(effectiveTimeout)}, moved to background.\nTask ID: ${bgTaskId}.\nOutput: ${bgFilepath}`
        const data: ToolOut = {
          stdout: msg,
          stdoutLines: 1,
          stderr: '',
          stderrLines: 0,
          interrupted: false,
          command,
        }
        yield { type: 'result', data, resultForAssistant: msg }
        return
      }

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

      const data: ToolOut = {
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
      const data: ToolOut = {
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
} satisfies Tool<In, ToolOut>
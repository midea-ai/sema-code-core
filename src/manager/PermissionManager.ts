import { Tool } from '../tools/base/Tool'
import { BashTool, inputSchema } from '../tools/Bash/Bash'
import { TOOL_NAME_FOR_PROMPT as EDIT_TOOL_NAME } from '../tools/Edit/prompt'
import { TOOL_NAME_FOR_PROMPT as WRITE_TOOL_NAME } from '../tools/Write/prompt'
import { TOOL_NAME_FOR_PROMPT as NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEdit/prompt'
import { getCommandSubcommandPrefix, splitCommand } from '../util/commands'
import { getCwd } from '../util/cwd'
import { logDebug, logError, logInfo } from '../util/log'
import { processHeredocCommand } from '../util/format'
import { REJECT_MESSAGE, CANCEL_MESSAGE, getCustomFeedbackMessage } from '../constants/message'
import { AssistantMessage } from '../types/message'
import { getConfManager } from './ConfManager'
import { getEventBus } from '../events/EventSystem'
import { ToolPermissionRequestData, ToolPermissionResponse } from '../events/types'
import { checkAbortSignal } from '../types/errors'
import { isFileInAuthorizedScope, getFilePath } from '../util/filePermission'
import { getStateManager } from './StateManager'

// ==================== 常量定义 ====================

const SAFE_COMMANDS = new Set([
  'git status', 'git diff', 'git log', 'git branch',
  'pwd', 'tree', 'date', 'which',
  'ls', 'find', 'grep', 'head', 'tail', 'cat', 'du', 'wc', 'echo', 'env', 'printenv'
])

const FILE_EDIT_TOOLS = new Set([
  EDIT_TOOL_NAME,
  WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME
])

// Skill 工具名称
const SKILL_TOOL_NAME = 'Skill'

// MCP 工具名称前缀
const MCP_TOOL_PREFIX = 'mcp__'

// ==================== 类型定义 ====================

type PermissionResult = { result: true } | { result: false; message: string }
type ToolInput = { [key: string]: unknown }

export type CanUseToolFn = (
  tool: Tool,
  input: ToolInput,
  abortController: AbortController,
  assistantMessage: AssistantMessage,
  agentId: string,
) => Promise<PermissionResult>

// ==================== 主权限检查函数 ====================

function isFileEditTool(tool: Tool): boolean {
  return FILE_EDIT_TOOLS.has(tool.name)
}

function isSkillTool(tool: Tool): boolean {
  return tool.name === SKILL_TOOL_NAME
}

function isMCPTool(tool: Tool): boolean {
  return tool.name.startsWith(MCP_TOOL_PREFIX)
}

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  abortController,
  _assistantMessage,
  agentId
): Promise<PermissionResult> => {
  checkAbortSignal(abortController)

  const coreConfig = getConfManager().getCoreConfig()
  const projectConfig = getConfManager().getProjectConfig()


  // 文件编辑工具权限检查
  if (isFileEditTool(tool)) {
    if (coreConfig?.skipFileEditPermission) {
      logDebug(`[Permission]${tool.name} 跳过编辑检查`)
      return {result: true }
    }

    const stateManager = getStateManager()
    if (stateManager.hasGlobalEditPermission()) {
      logDebug(`[Permission]${tool.name} hasGlobalEditPermission: True`)
      // 项目内直接读取，项目外需要请求权限
      const filePath = getFilePath(input)
      if (!filePath || isFileInAuthorizedScope(filePath)) {
        logDebug(`[Permission]${filePath} 会话级允许`)
        return { result: true }
      }
      else {
        logDebug(`[Permission]${filePath} 会话级允许，但项目外文件`)
      }
    }

    logDebug(`[Permission]${tool.name} hasGlobalEditPermission: False`)

    return requestPermissionViaEvent(tool, input, null, abortController, agentId)
  }

  // Bash 工具权限检查
  if (tool.name === BashTool.name) {
    if (coreConfig?.skipBashExecPermission) return { result: true }

    const allowedTools = projectConfig?.allowedTools || []
    const { command } = inputSchema.parse(input)
    return await checkBashPermission(tool, command, abortController, allowedTools, agentId)
  }

  // Skill 工具权限检查
  if (isSkillTool(tool)) {
    if (coreConfig?.skipSkillPermission) {
      return { result: true }
    }

    const allowedTools = projectConfig?.allowedTools || []
    const skillName = (input as any).skill || ''
    const permissionKey = skillName ? `${tool.name}(${skillName})` : tool.name

    if (allowedTools.includes(permissionKey)) {
      return { result: true }
    }

    return requestPermissionViaEvent(tool, input, null, abortController, agentId)
  }

  // MCP 工具权限检查
  if (isMCPTool(tool)) {
    if (coreConfig?.skipMCPToolPermission) {
      return { result: true }
    }

    const allowedTools = projectConfig?.allowedTools || []
    if (allowedTools.includes(tool.name)) {
      return { result: true }
    }

    return requestPermissionViaEvent(tool, input, null, abortController, agentId)
  }

  logDebug(`[Permission]${tool.name} 非编辑、bash、skill或mcp工具默认允许`)

  // 其他工具默认允许
  return { result: true }
}

// ==================== Bash 工具权限检查 ====================

function bashToolHasExactMatch(tool: Tool, command: string, allowedTools: string[]): boolean {
  if (SAFE_COMMANDS.has(command)) return true

  // 链式命令（&&、||、;）交由子命令分析处理，此处不做前缀匹配
  const hasChainOperator = /&&|\|\||;/.test(command)
  if (!hasChainOperator) {
    const pipeParts = command.split(/\s+\|\s+/)
    if (pipeParts.length > 1) {
      // 管道命令：每一段的主命令都必须在白名单，防止 "find . | rm -rf /" 绕过
      const allSafe = pipeParts.every(part => SAFE_COMMANDS.has(part.trim().split(' ')[0]))
      if (allSafe) return true
    } else {
      // 单条命令：主命令前缀匹配（如 "ls -la /path" 匹配 "ls"）
      const mainCommand = command.split(' ')[0]
      if (SAFE_COMMANDS.has(mainCommand)) return true
    }
  }

  const key = getPermissionKey(tool, { command }, null)
  if (allowedTools.includes(key)) return true

  const keyWithPrefix = getPermissionKey(tool, { command }, command)
  return allowedTools.includes(keyWithPrefix)
}

function bashToolHasPermission(
  tool: Tool,
  command: string,
  prefix: string | null,
  allowedTools: string[]
): boolean {
  return bashToolHasExactMatch(tool, command, allowedTools) ||
         allowedTools.includes(getPermissionKey(tool, { command }, prefix))
}

async function checkBashPermission(
  tool: Tool,
  command: string,
  abortController: AbortController,
  allowedTools: string[],
  agentId: string
): Promise<PermissionResult> {
  // 移除当前工作目录前缀 
  command = command.replace(`cd ${getCwd()} && `, '')

  // 命中白名单或项目配置已允许
  if (bashToolHasExactMatch(tool, command, allowedTools)) {
    return { result: true }
  }

  const subCommands = splitCommand(command)
  // LLM 提取前缀
  const commandInfo = await getCommandSubcommandPrefix(command, abortController.signal)

  // 防止中断后，还继续处理如弹出权限选择
  checkAbortSignal(abortController)

  if (!commandInfo || commandInfo.commandInjectionDetected) {
    return bashToolHasExactMatch(tool, command, allowedTools)
      ? { result: true }
      : requestPermissionViaEvent(tool, { command }, null, abortController, agentId)
  }

  if (subCommands.length < 2) {
    return bashToolHasPermission(tool, command, commandInfo.commandPrefix, allowedTools)
      ? { result: true }
      : requestPermissionViaEvent(tool, { command }, commandInfo.commandPrefix, abortController, agentId)
  }

  const allSubCommandsAllowed = subCommands.every(subCmd => {
    const prefixResult = commandInfo.subcommandPrefixes.get(subCmd)
    if (!prefixResult || prefixResult.commandInjectionDetected) return false
    return bashToolHasPermission(tool, subCmd, prefixResult.commandPrefix, allowedTools)
  })

  // 如果不是所有子命令都被允许，请求权限时使用主命令的前缀
  return allSubCommandsAllowed
    ? { result: true }
    : requestPermissionViaEvent(tool, { command }, commandInfo.commandPrefix, abortController, agentId)
}

// ==================== 权限保存 ====================

export async function savePermission(
  tool: Tool,
  input: ToolInput,
  prefix: string | null
): Promise<void> {
  // 文件编辑 会话内生效
  if (isFileEditTool(tool)) {
    const stateManager = getStateManager()
    stateManager.grantGlobalEditPermission()
    return
  }

  // bash、Skill、MCP 工具永久生效
  const key = getPermissionKey(tool, input, prefix)
  const confManager = getConfManager()
  const projectConfig = confManager.getProjectConfig()

  if (projectConfig?.allowedTools.includes(key)) return

  const config = projectConfig || { allowedTools: [] as string[] }
  config.allowedTools.push(key)
  config.allowedTools.sort()
  confManager.setProjectConfig(config)
}

function getPermissionKey(tool: Tool, input: ToolInput, prefix: string | null): string {
  if (tool.name === BashTool.name) {
    if (prefix) {
      return `${BashTool.name}(${prefix}:*)`
    }
    const command = processHeredocCommand((input as any).command || '')
    return `${BashTool.name}(${command})`
  }

  // Skill 工具使用 Skill(skillName) 格式作为权限键
  if (isSkillTool(tool)) {
    const skillName = (input as any).skill || ''
    return skillName ? `${tool.name}(${skillName})` : tool.name
  }

  // MCP 工具直接使用工具名作为权限键
  if (isMCPTool(tool)) {
    return tool.name
  }

  return tool.name
}

// ==================== 权限请求 ====================

async function requestPermissionViaEvent(
  tool: Tool,
  input: ToolInput,
  prefix: string | null,
  abortController: AbortController,
  agentId: string
): Promise<PermissionResult> {

  // 使用工具的 genToolPermission 方法获取 title 和 content
  const permissionInfo = tool.genToolPermission?.(input as any)

  const requestData: ToolPermissionRequestData = {
    agentId,
    toolName: tool.name,
    title: permissionInfo?.title || tool.name,
    content: permissionInfo?.content || '',
    options: buildPermissionOptions(tool, input, prefix)
  }

  const eventBus = getEventBus()
  eventBus.emit('tool:permission:request', requestData)

  return new Promise<PermissionResult>((resolve) => {
    // 清理函数：移除所有监听器
    const cleanup = () => {
      eventBus.off('tool:permission:response', handleResponse)
      abortController.signal.removeEventListener('abort', handleAbort)
    }

    const handleResponse = (response: ToolPermissionResponse) => {
      if (response.toolName !== tool.name) return

      cleanup()

      logInfo(`selected: ${response.selected}}`)
      switch (response.selected) {
        
        case 'agree':
          resolve({ result: true })
          break

        case 'allow':
          savePermission(tool, input, prefix)
            .then(() => resolve({ result: true }))
            .catch(error => {
              logError(`保存权限失败:${error}`)
              resolve({ result: true })
            })
          break

        case 'refuse':
          // 拒绝时触发中断，传递 'refuse' 作为 reason 以便区分
          abortController.abort('refuse')
          resolve({ result: false, message: REJECT_MESSAGE })
          break

        default:
          // 自定义反馈：不中断，返回带用户反馈的消息继续对话
          resolve({ result: false, message: getCustomFeedbackMessage(response.selected) })
          break
      }
    }

    // 处理中断信号：返回取消消息，与拒绝区分
    const handleAbort = () => {
      // 如果是因为用户点击"拒绝"导致的中断，不在这里处理
      // 因为 handleResponse 已经处理了并返回了 REJECT_MESSAGE
      const abortReason = (abortController.signal as any).reason
      if (abortReason === 'refuse') {
        return
      }

      cleanup()
      resolve({ result: false, message: CANCEL_MESSAGE })
    }

    // 检查是否已经被中断
    if (abortController.signal.aborted) {
      resolve({ result: false, message: CANCEL_MESSAGE })
      return
    }

    eventBus.on('tool:permission:response', handleResponse)
    abortController.signal.addEventListener('abort', handleAbort)
  })
}


function buildPermissionOptions(
  tool: Tool,
  input: ToolInput,
  prefix: string | null
): { agree: string; allow: string; refuse: string } {
  // Bash工具
  if (tool.name === BashTool.name) {
    const command = ((input as any).command || '').trim()
    const mainCommand = command.split(' ')[0]

    if (prefix) {
      return {
        agree: '确认',
        allow: `确认，本项目不再询问 \`${prefix}\` 开头的命令`,
        refuse: '拒绝'
      }
    }

    const allowText = command
      ? `确认，本项目不再询问 \`${command}\` 命令`
      : '确认，本项目不再询问此命令'

    return { agree: '确认', allow: allowText, refuse: '拒绝' }
  }

  // 编辑工具
  if (isFileEditTool(tool)) {
    return {
      agree: '确认',
      allow: '确认, 本项目不再询问文件编辑',
      refuse: '拒绝'
    }
  }

  // Skill 工具
  if (isSkillTool(tool)) {
    const skillName = (input as any).skill || ''
    return {
      agree: '确认',
      allow: skillName
        ? `确认，本项目不再询问 ${skillName} Skill`
        : `确认，本项目不再询问 Skill 工具`,
      refuse: '拒绝'
    }
  }

  // MCP 工具
  if (isMCPTool(tool)) {
    return {
      agree: '确认',
      allow: `确认，本项目不再询问 ${tool.name} 工具`,
      refuse: '拒绝'
    }
  }

  return {
    agree: '同意',
    allow: `同意，本项目不再询问 ${tool.name} 权限`,
    refuse: '拒绝'
  }
}
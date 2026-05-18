import { Tool } from '../tools/base/Tool'
import { RunShell, toolParams } from '../tools/RunShell'
import { TOOL_NAME_PATCH_FILE as PATCH_FILE_TOOL_NAME, TOOL_NAME_WRITE_FILE as WRITE_FILE_TOOL_NAME, TOOL_NAME_EDIT_NOTEBOOK as EDIT_NOTEBOOK_TOOL_NAME, TOOL_NAME_SKILL, TOOL_NAME_FETCH_URL } from '../prompt/tool'
import { getCommandSubcommandPrefix, splitCommand } from '../util/commands'
import { readInitialCwd } from '../util/cwd'
import { logDebug, logError, logInfo } from '../util/log'
import { REJECT_MSG, CANCEL_MSG, getCustomFeedbackMessage } from '../util/message'
import { getConfManager } from './ConfManager'
import { getEventBus } from '../events/EventSystem'
import { ToolPermissionRequestData, ToolPermissionResponse } from '../events/types'
import { checkAbortSignal } from '../types/errors'
import { getFilePath } from '../util/file'
import { isAbsolute, resolve, relative } from 'path'
import { normalizeCmpPath } from '../util/platform'
import { getStateManager } from './StateManager'

// ==================== 辅助函数 ====================

function isPathInsideRoot(filePath: string, root: string): boolean {
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath)
  const rel = relative(normalizeCmpPath(root), normalizeCmpPath(abs))
  if (!rel || rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

// ==================== 常量定义 ====================

const SAFE_COMMANDS = new Set([
  'git status', 'git diff', 'git log', 'git branch',
  'pwd', 'tree', 'date', 'which',
  'ls', 'find', 'grep', 'head', 'tail', 'cat', 'du', 'wc', 'echo', 'env', 'printenv'
])

const FILE_EDIT_TOOLS = new Set([
  PATCH_FILE_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  EDIT_NOTEBOOK_TOOL_NAME
])

// Skill 工具名称
const SKILL_TOOL_ID = TOOL_NAME_SKILL

// MCP 工具名称前缀
const MCP_TOOL_PREFIX = 'mcp__'

// fetch_url 工具名称
const FETCH_URL_TOOL_NAME = TOOL_NAME_FETCH_URL

// ==================== 类型定义 ====================

type PermissionCheckResult = { result: true } | { result: false; message: string }
type ToolInvocationArgs = { [key: string]: unknown }

// ==================== 主权限检查函数 ====================

function isFileEditTool(tool: Tool): boolean {
  return FILE_EDIT_TOOLS.has(tool.name)
}

function isSkillTool(tool: Tool): boolean {
  return tool.name === SKILL_TOOL_ID
}

function isMCPTool(tool: Tool): boolean {
  return tool.name.startsWith(MCP_TOOL_PREFIX)
}

function isFetchUrlTool(tool: Tool): boolean {
  return tool.name === FETCH_URL_TOOL_NAME
}

/**
 * 从 URL 中提取域名（不含协议、端口、路径）
 */
const extractDomain = (url: string): string | null => {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

export const checkToolPermission = async (
  tool: Tool,
  input: ToolInvocationArgs,
  abortController: AbortController,
  _assistantMessage: unknown,
  agentId: string,
  sessionId: string,
  toolId: string
): Promise<PermissionCheckResult> => {
  checkAbortSignal(abortController)

  const coreConfig = getConfManager().getCoreConfig()
  const projectConfig = getConfManager().getProjectConfig()


  // 文件编辑工具权限检查
  if (isFileEditTool(tool)) {
    if (coreConfig?.skipFileEditPermission) {
      logDebug(`[Permission]${tool.name} 跳过编辑检查`)
      return {result: true }
    }

    const runtime = getStateManager().session(sessionId)
    if (runtime.hasGlobalEditPermission()) {
      logDebug(`[Permission]${tool.name} hasGlobalEditPermission: True`)
      // 项目内直接读取，项目外需要请求权限
      const filePath = getFilePath(input)
      if (!filePath || isPathInsideRoot(filePath, readInitialCwd())) {
        logDebug(`[Permission]${filePath} 会话级允许`)
        return { result: true }
      }
      else {
        logDebug(`[Permission]${filePath} 会话级允许，但项目外文件`)
      }
    }

    logDebug(`[Permission]${tool.name} hasGlobalEditPermission: False`)

    return requestPermissionViaEvent(tool, input, null, abortController, agentId, sessionId, toolId)
  }

  // run_shell 工具权限检查
  if (tool.name === RunShell.name) {
    if (coreConfig?.skipShellExecPermission) return { result: true }

    const allowedTools = projectConfig?.allowedTools || []
    const { command } = toolParams.parse(input)
    return await checkRunShellPermission(tool, command, abortController, allowedTools, agentId, sessionId, toolId)
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

    return requestPermissionViaEvent(tool, input, null, abortController, agentId, sessionId, toolId)
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

    return requestPermissionViaEvent(tool, input, null, abortController, agentId, sessionId, toolId)
  }

  // fetch_url 工具权限检查
  if (isFetchUrlTool(tool)) {
    if (coreConfig?.skipFetchUrlPermission) {
      return { result: true }
    }

    const allowedTools = projectConfig?.allowedTools || []
    const url = (input as any).url

    if (url) {
      const domain = extractDomain(url)
      if (domain && allowedTools.includes(`${FETCH_URL_TOOL_NAME}(${domain})`)) {
        return { result: true }
      }
    }

    return requestPermissionViaEvent(tool, input, null, abortController, agentId, sessionId, toolId)
  }

  logDebug(`[Permission]${tool.name} 非编辑、run_shell、skill、mcp或webfetch工具默认允许`)

  // 其他工具默认允许
  return { result: true }
}

// ==================== run_shell 工具权限检查 ====================

function runShellToolHasExactMatch(tool: Tool, command: string, allowedTools: string[]): boolean {
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

function isRunShellCommandPermitted(
  tool: Tool,
  command: string,
  prefix: string | null,
  allowedTools: string[]
): boolean {
  return runShellToolHasExactMatch(tool, command, allowedTools) ||
         allowedTools.includes(getPermissionKey(tool, { command }, prefix))
}

async function checkRunShellPermission(
  tool: Tool,
  command: string,
  abortController: AbortController,
  allowedTools: string[],
  agentId: string,
  sessionId: string,
  toolId: string
): Promise<PermissionCheckResult> {
  // 移除当前工作目录前缀 
  command = command.replace(`cd ${readInitialCwd()} && `, '')

  // 命中白名单或项目配置已允许
  if (runShellToolHasExactMatch(tool, command, allowedTools)) {
    return { result: true }
  }

  const subCommands = splitCommand(command)
  // LLM 提取前缀
  const commandInfo = await getCommandSubcommandPrefix(command, abortController.signal)

  // 防止中断后，还继续处理如弹出权限选择
  checkAbortSignal(abortController)

  if (!commandInfo || commandInfo.commandInjectionDetected) {
    return runShellToolHasExactMatch(tool, command, allowedTools)
      ? { result: true }
      : requestPermissionViaEvent(tool, { command }, null, abortController, agentId, sessionId, toolId, false)
  }

  if (subCommands.length < 2) {
    return isRunShellCommandPermitted(tool, command, commandInfo.commandPrefix, allowedTools)
      ? { result: true }
      : requestPermissionViaEvent(tool, { command }, commandInfo.commandPrefix, abortController, agentId, sessionId, toolId)
  }

  const allSubCommandsAllowed = subCommands.every(subCmd => {
    const prefixResult = commandInfo.subcommandPrefixes.get(subCmd)
    if (!prefixResult || prefixResult.commandInjectionDetected) return false
    return isRunShellCommandPermitted(tool, subCmd, prefixResult.commandPrefix, allowedTools)
  })

  // 如果不是所有子命令都被允许，请求权限时使用主命令的前缀
  return allSubCommandsAllowed
    ? { result: true }
    : requestPermissionViaEvent(tool, { command }, commandInfo.commandPrefix, abortController, agentId, sessionId, toolId)
}

// ==================== 权限保存 ====================

export async function savePermission(
  tool: Tool,
  input: ToolInvocationArgs,
  prefix: string | null,
  sessionId: string
): Promise<void> {
  // 文件编辑 会话内生效
  if (isFileEditTool(tool)) {
    getStateManager().session(sessionId).grantGlobalEditPermission()
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

function getPermissionKey(tool: Tool, input: ToolInvocationArgs, prefix: string | null): string {
  if (tool.name === RunShell.name) {
    if (prefix) {
      return `${RunShell.name}(${prefix}:*)`
    }
    return `${RunShell.name}(${(input as any).command || ''})`
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

  // fetch_url 工具使用 fetch_url(domain) 格式作为权限键
  if (isFetchUrlTool(tool)) {
    const url = (input as any).url || ''
    const domain = extractDomain(url)
    return domain ? `${tool.name}(${domain})` : tool.name
  }

  return tool.name
}

// ==================== 权限请求 ====================

async function requestPermissionViaEvent(
  tool: Tool,
  input: ToolInvocationArgs,
  prefix: string | null,
  abortController: AbortController,
  agentId: string,
  sessionId: string,
  toolId: string,
  showAllow = true
): Promise<PermissionCheckResult> {

  // 使用工具的 genToolPermission 方法获取 title 和 content
  const permissionInfo = tool.genToolPermission?.(input as any)

  const requestData: ToolPermissionRequestData = {
    agentId,
    toolId,
    toolName: tool.name,
    title: permissionInfo?.title || tool.name,
    content: permissionInfo?.content || '',
    options: buildPermissionOptions(tool, input, prefix, showAllow)
  }

  const eventBus = getEventBus()
  eventBus.emit('tool:permission:request', requestData, sessionId)

  return new Promise<PermissionCheckResult>((resolve) => {
    // 清理函数：移除所有监听器
    const disposeHandle = () => {
      eventBus.off('tool:permission:response', handleResponse)
      abortController.signal.removeEventListener('abort', onAbortRequested)
    }

    const handleResponse = (response: ToolPermissionResponse) => {
      if (response.toolId !== toolId) return

      disposeHandle()

      logInfo(`selected: ${response.selected}}`)
      switch (response.selected) {
        
        case 'agree':
          resolve({ result: true })
          break

        case 'allow':
          savePermission(tool, input, prefix, sessionId)
            .then(() => resolve({ result: true }))
            .catch(error => {
              logError(`保存权限失败:${error}`)
              resolve({ result: true })
            })
          break

        case 'refuse':
          // 拒绝时触发中断，传递 'refuse' 作为 reason 以便区分
          abortController.abort('refuse')
          resolve({ result: false, message: REJECT_MSG })
          break

        default:
          // 自定义反馈：不中断，返回带用户反馈的消息继续对话
          resolve({ result: false, message: getCustomFeedbackMessage(response.selected) })
          break
      }
    }

    // 处理中断信号：返回取消消息，与拒绝区分
    const onAbortRequested = () => {
      // 如果是因为用户点击"拒绝"导致的中断，不在这里处理
      // 因为 handleResponse 已经处理了并返回了 REJECT_MSG
      const abortReason = (abortController.signal as any).reason
      if (abortReason === 'refuse') {
        return
      }

      disposeHandle()
      resolve({ result: false, message: CANCEL_MSG })
    }

    // 检查是否已经被中断
    if (abortController.signal.aborted) {
      resolve({ result: false, message: CANCEL_MSG })
      return
    }

    eventBus.on('tool:permission:response', handleResponse, sessionId)
    abortController.signal.addEventListener('abort', onAbortRequested)
  })
}


function buildPermissionOptions(
  tool: Tool,
  input: ToolInvocationArgs,
  prefix: string | null,
  showAllow = true
): Record<string, string> {
  // run_shell工具
  if (tool.name === RunShell.name) {
    const command = ((input as any).command || '').trim()

    if (!showAllow) {
      return { agree: '确认', refuse: '拒绝' }
    }

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
      allow: '确认, 本次会话不再询问文件编辑',
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

  // fetch_url 工具
  if (isFetchUrlTool(tool)) {
    const url = (input as any).url || ''
    const domain = extractDomain(url)
    return {
      agree: '确认',
      allow: domain
        ? `确认，本项目不再询问 ${domain} 域名`
        : '确认，本项目不再询问此域名',
      refuse: '拒绝'
    }
  }

  return {
    agree: '同意',
    allow: `同意，本项目不再询问 ${tool.name} 权限`,
    refuse: '拒绝'
  }
}
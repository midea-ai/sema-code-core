import { Tool } from '../tools/base/Tool'
import { RunShell, toolParams } from '../tools/RunShell'
import { TOOL_NAME_PATCH_FILE as PATCH_FILE_TOOL_NAME, TOOL_NAME_WRITE_FILE as WRITE_FILE_TOOL_NAME, TOOL_NAME_EDIT_NOTEBOOK as EDIT_NOTEBOOK_TOOL_NAME, TOOL_NAME_SKILL, TOOL_NAME_FETCH_URL } from '../prompt/tool'
import { splitCommand, hasCommandInjection, getCommandPrefix } from '../util/commands'
import { readInitialCwd } from '../util/cwd'
import { logDebug, logError, logInfo } from '../util/log'
import { REJECT_MSG, CANCEL_MSG, getCustomFeedbackMessage, API_ERR_PREFIX, prepareMessagesForApi, buildUserMsg } from '../util/message'
import { getConfManager } from './ConfManager'
import { getEventBus } from '../events/EventSystem'
import { ToolPermissionRequestData, ToolPermissionResponse } from '../events/types'
import { checkAbortSignal } from '../types/errors'
import { getFilePath } from '../util/file'
import { isAbsolute, resolve, relative } from 'path'
import { normalizeCmpPath } from '../util/platform'
import { getStateManager, MAIN_AGENT_ID } from './StateManager'
import { queryLLM } from '../services/api/queryLLM'
import { NULL_TOOL } from '../util/compact'
import { AUTO_RUN_SAFETY_CONTEXT_SYSTEM_PROMPT, AUTO_RUN_SAFETY_CONTEXT_USER_PROMPT } from '../prompt/permission'

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

// 子命令字符长度上限：超过则跳过前缀提取（如内联脚本 python -c "...大段..."，提取前缀无意义），
// 同时不提供「按前缀授权」，只允许单次确认。
// 取值偏宽：容得下带多个长绝对路径的正常命令；超限仅丢失「按前缀授权」便利，不影响命令本身可单次执行。
const MAX_PREFIX_EXTRACT_LEN = 512

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

// 已保存的前缀授权 run_shell(P:*) 用字符串前缀匹配判定覆盖，无需模型提取前缀
function matchesSavedPrefix(command: string, allowedTools: string[]): boolean {
  const open = `${RunShell.name}(`
  for (const entry of allowedTools) {
    if (!entry.startsWith(open) || !entry.endsWith(':*)')) continue
    const prefix = entry.slice(open.length, -':*)'.length)
    if (prefix && (command === prefix || command.startsWith(`${prefix} `))) return true
  }
  return false
}

function isRunShellCommandPermitted(
  tool: Tool,
  command: string,
  allowedTools: string[]
): boolean {
  return runShellToolHasExactMatch(tool, command, allowedTools) ||
         matchesSavedPrefix(command, allowedTools)
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

  // 先拆分子命令并做注入检测——必须先于白名单/AutoRun 放行，否则白名单主命令词（echo/cat/grep 等）
  // 夹带 $()、`` 命令替换或换行即可绕过检测（如 echo $(id)）。检出注入 → 转人工且不提供"永久允许"
  const subCommands = splitCommand(command)
  if (subCommands.some(hasCommandInjection)) {
    return requestPermissionViaEvent(tool, { command }, null, abortController, agentId, sessionId, toolId, false, true)
  }

  // 命中白名单或项目配置已允许
  if (runShellToolHasExactMatch(tool, command, allowedTools)) {
    return { result: true }
  }

  // AutoRun 档位：对整条命令做一次安全判断，判定 safe 直接放行；
  // 判定有风险时继续走下面的确定性覆盖匹配（已保存授权仍可放行），否则转人工。
  const runtime = getStateManager().session(sessionId)
  if (runtime.isAutoRun()) {
    let safe = false
    try {
      safe = (await classifyActionSafety(tool, { command }, abortController.signal, sessionId, agentId)) === 'safe'
    } catch (error) {
      logDebug(`[Permission][AutoRun] 安全判断失败，转人工: ${error}`)
    }
    checkAbortSignal(abortController)
    if (safe) {
      logDebug(`[Permission][AutoRun]${tool.name} 自动放行`)
      return { result: true }
    }
    logDebug(`[Permission][AutoRun]${tool.name} 判定有风险，转人工申请`)
  }

  // 每个子命令都被 SAFE_COMMANDS / 精确授权 / 已保存前缀覆盖 → 放行（注入已在函数开头排除）
  if (subCommands.length > 0 && subCommands.every(subCmd => isRunShellCommandPermitted(tool, subCmd, allowedTools))) {
    return { result: true }
  }

  // 未完全覆盖 → 转人工。对「首个未被覆盖的子命令」调一次快速模型提取前缀，给出"按前缀授权"选项。
  // 必须用子命令而非整条命令——整条复合命令含 && / || / ; 会被前缀提取提示词判为注入，提取不到前缀。
  // 首个未覆盖子命令过长（如内联脚本 python -c "...大段..."）时跳过前缀提取：提取无意义
  const firstUncovered = subCommands.find(subCmd => !isRunShellCommandPermitted(tool, subCmd, allowedTools)) ?? command
  let prefix: string | null = null
  let allowExact = false
  if (firstUncovered.length <= MAX_PREFIX_EXTRACT_LEN) {
    const info = await getCommandPrefix(firstUncovered, abortController.signal, sessionId)
    checkAbortSignal(abortController)
    if (info === null) {
      // 模型调用失败 → 退化「精确命令授权」run_shell(<完整命令>)（命令不超长时），下次同一条命令可放行
      allowExact = command.length <= MAX_PREFIX_EXTRACT_LEN
    } else if (info.commandInjectionDetected || !info.commandPrefix) {
      // 检出注入 或 返回 none/git（如 git push）：模型明确判定不宜授权 → 不给 allow，仅单次确认
    } else {
      // 提到有效前缀 → 「按前缀授权」run_shell(<前缀>:*)
      prefix = info.commandPrefix
    }
  }

  // 有前缀 → 按前缀授权；模型失败且命令不超长 → 精确命令授权；其余（注入/none/超长）→ 无 allow，仅单次确认
  const showAllow = prefix !== null || allowExact

  return requestPermissionViaEvent(tool, { command }, prefix, abortController, agentId, sessionId, toolId, showAllow, true)
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

// ==================== AutoRun 自动判断 ====================

/**
 * 将单个工具动作概括为一段可供快速模型判断的描述文本。
 */
function buildActionSummary(tool: Tool, input: ToolInvocationArgs): string {
  if (tool.name === RunShell.name) {
    const command = ((input as any).command || '').toString().trim()
    return `Tool: run_shell\nCommand: ${command}`
  }

  if (isFileEditTool(tool)) {
    const filePath = getFilePath(input)
    const outside = !!filePath && !isPathInsideRoot(filePath, readInitialCwd())
    return `Tool: ${tool.name} (edit/write file)\nPath: ${filePath || '(unknown)'}\nLocation: ${outside ? 'OUTSIDE project directory' : 'inside project directory'}`
  }

  if (isSkillTool(tool)) {
    return `Tool: Skill\nSkill: ${(input as any).skill || '(unknown)'}`
  }

  if (isFetchUrlTool(tool)) {
    const url = (input as any).url || ''
    return `Tool: fetch_url\nURL: ${url}\nDomain: ${extractDomain(url) || '(unknown)'}`
  }

  const label = isMCPTool(tool) ? `${tool.name} (MCP tool)` : tool.name
  return `Tool: ${label}\nArgs: ${safeStringify(input)}`
}

function safeStringify(input: unknown, max = 800): string {
  try {
    const s = JSON.stringify(input)
    return s.length > max ? `${s.slice(0, max)}…(truncated)` : s
  } catch {
    return '(unserializable)'
  }
}

/**
 * 调用快速模型判断动作是否安全。
 * API 错误或返回为空时抛出异常，交由调用方做失败关闭处理。
 */
async function classifyActionSafety(
  tool: Tool,
  input: ToolInvocationArgs,
  signal: AbortSignal,
  sessionId?: string,
  agentId: string = MAIN_AGENT_ID,
): Promise<'safe' | 'risky'> {
  // 旁路：只读「当前执行代理」自身历史作为上下文（子代理用自己的上下文，而非主代理），
  // 叠加安全判断指令，绝不写回会话
  const history = sessionId
    ? getStateManager().session(sessionId).forAgent(agentId).getMessageHistory()
    : []

  // 末尾追加待判断动作；prepareMessagesForApi 会剥离历史尾部孤立 tool_use，
  // 配合 NULL_TOOL 占位避免部分 provider 因历史含 tool 块报错
  const actionMsg = buildUserMsg([
    { type: 'text', text: AUTO_RUN_SAFETY_CONTEXT_USER_PROMPT(buildActionSummary(tool, input)) },
  ])
  const messages = [...prepareMessagesForApi(history), actionMsg]

  const response = await queryLLM(
    messages,
    [{ type: 'text', text: AUTO_RUN_SAFETY_CONTEXT_SYSTEM_PROMPT }],
    signal,
    [NULL_TOOL],
    {
      modelPointer: 'quick',
      disableChunkEvents: true,
      disableErrorEvents: true,
      disableThinking: true,
      sessionId,
    }
  )

  const content = response.message.content
  const raw = (
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? ((content.find((c: any) => c.type === 'text') as any)?.text ?? '')
        : ''
  ).trim()

  if (!raw || raw.startsWith(API_ERR_PREFIX)) {
    throw new Error('AutoRun safety classification failed')
  }

  // 仅当模型明确返回单词 safe 时才放行；带解释/标点/其余任何文本一律按 risky 处理（fail-closed）
  return raw.toLowerCase() === 'safe' ? 'safe' : 'risky'
}

/**
 * fetch_url 的确定性 SSRF 兜底：命中环回 / 链路本地（含云元数据 169.254.169.254）/
 * 内网 / 未指定地址 / 本地主机名，一律按危险处理，不交给模型，避免被误判为 safe。
 * URL 解析失败同样按危险处理。
 */
function isBlockedFetchHost(url: string): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return true
  }

  // 去掉 IPv6 字面量的方括号
  const host = hostname.replace(/^\[|\]$/g, '')

  // 本地主机名 / 已知云元数据主机名
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === 'metadata.google.internal') return true

  // IPv4 字面量
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a === 0) return true                          // 0.0.0.0/8 未指定
    if (a === 10) return true                         // 10.0.0.0/8 私网
    if (a === 127) return true                        // 127.0.0.0/8 环回
    if (a === 169 && b === 254) return true           // 169.254.0.0/16 链路本地（含元数据）
    if (a === 172 && b >= 16 && b <= 31) return true  // 172.16.0.0/12 私网
    if (a === 192 && b === 168) return true           // 192.168.0.0/16 私网
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT
    return false
  }

  // IPv6 字面量：环回 / 未指定 / ULA(fc00::/7) / 链路本地(fe80::/10)
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true
    if (/^f[cd]/.test(host)) return true   // fc00::/7
    if (/^fe[89ab]/.test(host)) return true // fe80::/10
    return false
  }

  return false
}

/**
 * AutoRun 档位下尝试自动放行：
 * 1) 确定性：文件编辑只看路径（项目内放行/项目外转人工）；Skill 放行；MCP 转人工——均不走 LLM
 * 2) fetch_url：先做确定性 SSRF 兜底（命中内网/元数据等直接转人工），未命中再交给快速模型判断
 * 3) 其余动作交给快速模型做安全判断；失败/超时/异常一律失败关闭（转人工）
 */
async function autoApproveInAutoRun(
  tool: Tool,
  input: ToolInvocationArgs,
  signal: AbortSignal,
  sessionId?: string,
  agentId?: string,
): Promise<boolean> {
  // 文件编辑：确定性判断，不走 LLM
  // 项目内放行；项目外一律转人工，避免模型误判为 safe
  if (isFileEditTool(tool)) {
    const filePath = getFilePath(input)
    return !filePath || isPathInsideRoot(filePath, readInitialCwd())
  }

  // Skill：本身无副作用（仅注入提示词），技能内的真实动作会作为下游工具再次过权限闸门，直接放行
  if (isSkillTool(tool)) {
    return true
  }

  // MCP：外部且不可逆的副作用，下游不再拦截，工具语义对模型不透明，未白名单一律转人工
  if (isMCPTool(tool)) {
    return false
  }

  // fetch_url：先做确定性 SSRF 兜底，命中内网/链路本地/元数据等直接转人工，不交给模型
  if (isFetchUrlTool(tool)) {
    const url = ((input as any).url || '').toString()
    if (isBlockedFetchHost(url)) {
      logDebug(`[Permission][AutoRun] fetch_url 命中内网/元数据 denylist，转人工: ${url}`)
      return false
    }
  }

  // 其余（fetch_url 通过兜底后等）：交给快速模型判断（run_shell 已在 checkRunShellPermission 中提前判断）
  try {
    return (await classifyActionSafety(tool, input, signal, sessionId, agentId)) === 'safe'
  } catch (error) {
    logDebug(`[Permission][AutoRun] 安全判断失败，转人工: ${error}`)
    return false
  }
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
  showAllow = true,
  skipAutoRun = false
): Promise<PermissionCheckResult> {

  // AutoRun 档位：发出人工权限申请前，先尝试自动放行
  // skipAutoRun=true 表示调用方（如 run_shell）已完成 AutoRun 判断，避免重复的快速模型调用
  const runtime = getStateManager().session(sessionId)
  if (!skipAutoRun && runtime.isAutoRun()) {
    if (await autoApproveInAutoRun(tool, input, abortController.signal, sessionId, agentId)) {
      checkAbortSignal(abortController)
      logDebug(`[Permission][AutoRun]${tool.name} 自动放行`)
      return { result: true }
    }
    checkAbortSignal(abortController)
    logDebug(`[Permission][AutoRun]${tool.name} 判定有风险，转人工申请`)
  }

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
import { Tool } from '../tools/base/Tool'
import { RunShell, toolParams } from '../tools/RunShell'
import { TOOL_NAME_PATCH_FILE as PATCH_FILE_TOOL_NAME, TOOL_NAME_WRITE_FILE as WRITE_FILE_TOOL_NAME, TOOL_NAME_EDIT_NOTEBOOK as EDIT_NOTEBOOK_TOOL_NAME, TOOL_NAME_SKILL, TOOL_NAME_FETCH_URL, TOOL_NAME_VIEW_FILE } from '../prompt/tool'
import { splitCommand, hasCommandInjection, getCommandPrefix, stripHeredocBody } from '../util/commands'
import { readInitialCwd } from '../util/cwd'
import { logDebug, logError, logInfo } from '../util/log'
import { REJECT_MSG, CANCEL_MSG, getCustomFeedbackMessage, API_ERR_PREFIX, buildUserMsg } from '../util/message'
import { getConfManager } from './ConfManager'
import { getEventBus } from '../events/EventSystem'
import { ToolPermissionRequestData, ToolPermissionResponse, ToolPermissionAutoData } from '../events/types'
import { checkAbortSignal } from '../types/errors'
import { getFilePath } from '../util/file'
import { isAbsolute, resolve, relative, dirname } from 'path'
import { tmpdir } from 'os'
import { normalizeCmpPath } from '../util/platform'
import { getStateManager, MAIN_AGENT_ID } from './StateManager'
import { queryLLM } from '../services/api/queryLLM'
import { AUTO_RUN_SAFETY_CONTEXT_SYSTEM_PROMPT } from '../prompt/permission'
import { isReadonlySafeCommand, isUnsafeForPrefixAuth, hasDangerousCommand } from '../util/shellSafety'
import { extractAutoRunContext, summarizeActionLine } from '../util/autoRunContext'
import { isBlockedFetchHost } from '../util/fetchSafety'

// ==================== 辅助函数 ====================

function isPathInsideRoot(filePath: string, root: string): boolean {
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath)
  const rel = relative(normalizeCmpPath(root), normalizeCmpPath(abs))
  if (!rel || rel === '') return true
  return !rel.startsWith('..') && !isAbsolute(rel)
}

// 系统临时目录：这些目录树下的文件视为临时文件，AutoEdit/AutoRun 下即便在项目外也自动放行
// tmpdir() 已涵盖 $TMPDIR/$TEMP/$TMP；/var/folders 覆盖 macOS 临时/缓存区
const TEMP_BASE_PATHS = [tmpdir(), '/tmp', '/var/tmp', '/var/folders']

function isTempFile(filePath: string): boolean {
  // 相对路径按项目根解析（解析后必落在项目内，由 isPathInsideRoot 处理）；临时文件均为绝对路径
  const abs = isAbsolute(filePath) ? filePath : resolve(readInitialCwd(), filePath)
  const absNorm = normalizeCmpPath(abs)
  return TEMP_BASE_PATHS.some(base => {
    const rel = relative(normalizeCmpPath(base), absNorm)
    if (!rel || rel === '') return true
    return !rel.startsWith('..') && !isAbsolute(rel)
  })
}

// ==================== 常量定义 ====================

// 子命令字符长度上限：超过则跳过前缀提取（如内联脚本 python -c "...大段..."，提取前缀无意义），
// 同时不提供「按前缀授权」，只允许单次确认。
// 取值偏宽：容得下带多个长绝对路径的正常命令；超限仅丢失「按前缀授权」便利，不影响命令本身可单次执行。
const MAX_PREFIX_EXTRACT_LEN = 512

// 精确命令授权（run_shell(<完整命令>)）的命令长度上限：前缀提取失败时，仅当整条命令足够短才退化为
// 「按完整命令授权」。过长的完整命令逐字命中概率低，精确授权意义不大，故超过此长度只允许单次确认。
const MAX_EXACT_AUTH_LEN = 64

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
      // 项目内或临时文件直接放行，其余项目外文件需要请求权限
      const filePath = getFilePath(input)
      if (!filePath || isPathInsideRoot(filePath, readInitialCwd()) || isTempFile(filePath)) {
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

  // 文件读取工具权限检查：仅项目外文件需要权限
  if (tool.name === TOOL_NAME_VIEW_FILE) {
    if (coreConfig?.skipExternalFileReadPermission) {
      logDebug(`[Permission]${tool.name} 跳过项目外读取检查`)
      return { result: true }
    }

    const filePath = getFilePath(input)
    // 项目内或临时文件：直接放行，保持静默
    if (!filePath || isPathInsideRoot(filePath, readInitialCwd()) || isTempFile(filePath)) {
      return { result: true }
    }

    // 项目外文件：auto 模式（非 Ask）自动放行
    const runtime = getStateManager().session(sessionId)
    if (runtime.hasGlobalEditPermission()) {
      logDebug(`[Permission]${filePath} 项目外读取，auto 模式自动放行`)
      return { result: true }
    }

    // 命中本会话已授权的父目录则放行
    const absPath = isAbsolute(filePath) ? filePath : resolve(readInitialCwd(), filePath)
    if (runtime.getAllowedExternalReadDirs().some(dir => isPathInsideRoot(absPath, dir))) {
      logDebug(`[Permission]${filePath} 项目外读取，命中会话级已授权目录`)
      return { result: true }
    }

    // 否则请求权限，prefix 传父目录，供「允许」时按目录授权
    logDebug(`[Permission]${filePath} 项目外读取，请求权限`)
    return requestPermissionViaEvent(tool, input, dirname(absPath), abortController, agentId, sessionId, toolId)
  }

  // run_shell 工具权限检查
  if (tool.name === RunShell.name) {
    if (coreConfig?.skipShellExecPermission) return { result: true }

    const allowedTools = projectConfig?.allowedTools || []
    const { command, description } = toolParams.parse(input)
    return await checkRunShellPermission(tool, command, abortController, allowedTools, agentId, sessionId, toolId, description)
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

    // 内网/链路本地/元数据等 SSRF 兜底命中的主机：即便已保存域名授权也不放行（纵深防御，
    // 治存量配置），且转人工时不提供「永久允许该域名」选项，避免一键给内网地址开永久通行证。
    const blocked = url ? isBlockedFetchHost(url) : false

    if (url && !blocked) {
      const domain = extractDomain(url)
      if (domain && allowedTools.includes(`${FETCH_URL_TOOL_NAME}(${domain})`)) {
        return { result: true }
      }
    }

    return requestPermissionViaEvent(tool, input, null, abortController, agentId, sessionId, toolId, !blocked)
  }

  logDebug(`[Permission]${tool.name} 非编辑、run_shell、skill、mcp或webfetch工具默认允许`)

  // 其他工具默认允许
  return { result: true }
}

// ==================== run_shell 工具权限检查 ====================

function runShellToolHasExactMatch(tool: Tool, command: string, allowedTools: string[]): boolean {
  // 只读安全命令快速通道：基于 splitCommand 分词逐子命令判定，
  // 杜绝「整串 split(' ')[0]」导致的重定向 / 不带空格管道 / find 危险 flag 绕过
  if (isReadonlySafeCommand(command)) return true

  const key = getPermissionKey(tool, { command }, null)
  if (allowedTools.includes(key)) return true

  const keyWithPrefix = getPermissionKey(tool, { command }, command)
  return allowedTools.includes(keyWithPrefix)
}

// 已保存的前缀授权 run_shell(P:*) 用字符串前缀匹配判定覆盖，无需模型提取前缀
function matchesSavedPrefix(command: string, allowedTools: string[]): boolean {
  // 前缀匹配只看首词，无法识别参数/重定向带来的危险。危险命令（含重定向、rm/sudo/mv
  // 等危险首词、find 危险 flag）即便首词被前缀授权也不放行，避免 `rm:*`/`echo:*` 退化为
  // 任意删除/写文件原语。
  if (isUnsafeForPrefixAuth(command)) return false
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
  toolId: string,
  description?: string
): Promise<PermissionCheckResult> {
  // 归一化首尾空白：命令常带尾随换行（如 heredoc 结束符后的 \n）。不 trim 会让 stripHeredocBody
  // 剥离正文后骨架残留一个空行 → 误判「结束符后藏了第二条命令」→ 合法 heredoc 脚本被当成注入。
  // trim 只去首尾空白，不影响 ; / $() / 第二条命令等真注入向量的检出。
  command = command.trim()
  // 移除当前工作目录前缀
  command = command.replace(`cd ${readInitialCwd()} && `, '')

  // 先拆分子命令并做注入检测——必须先于白名单/AutoRun 放行，否则白名单主命令词（echo/cat/grep 等）
  // 夹带 $()、`` 命令替换或换行即可绕过检测（如 echo $(id)）。检出注入 → 转人工且不提供"永久允许"
  const subCommands = splitCommand(command)
  // heredoc 正文是喂给程序的数据而非 shell 命令，但底层 shell-quote 不理解 heredoc，会把正文打散、
  // 换行有时残留，导致合法的多行内联脚本（python3 << 'EOF' ...）被误判注入、跳过 AutoRun 模型判断。
  // 注入检测改在「剥离 heredoc 正文后的骨架」上进行：成功剥离后骨架若仍残留换行，只能是结束符之后
  // 藏了第二条命令 → 判注入；否则按子命令逐段检测。无法安全剥离（多 heredoc 同行/缺结束符/不带引号
  // 且正文含命令替换）时 stripHeredocBody 原样返回，退回逐段检测，绝不因剥离而放过真注入。
  const injectionSkeleton = stripHeredocBody(command)
  const injectionDetected = injectionSkeleton !== command
    ? injectionSkeleton.includes('\n') || splitCommand(injectionSkeleton).some(hasCommandInjection)
    : subCommands.some(hasCommandInjection)
  if (injectionDetected) {
    return requestPermissionViaEvent(tool, { command, description }, null, abortController, agentId, sessionId, toolId, false, true)
  }

  // 命中白名单或项目配置已允许
  if (runShellToolHasExactMatch(tool, command, allowedTools)) {
    return { result: true }
  }

  // 确定性危险命令（rm/sudo/mv 等危险首词、find 危险 flag）：直接转人工，不调模型。
  // 这类命令语义本身危险，不该给模型机会判 safe 放行；也不提供前缀授权（showAllow=false）。
  // skipAutoRun=true 跳过 requestPermissionViaEvent 内的 AutoRun 自动放行，避免再次调用模型。
  if (hasDangerousCommand(command)) {
    return requestPermissionViaEvent(tool, { command, description }, null, abortController, agentId, sessionId, toolId, false, true)
  }

  // 每个子命令都被 SAFE_COMMANDS / 精确授权 / 已保存前缀覆盖 → 放行（注入已在函数开头排除）。
  // 必须先于下面的 AutoRun 模型判断：已被「确定性覆盖」的命令无需再调用快速模型——既省一次模型
  // 调用，也更准确（确定性放行不应触发「模型自动放行」事件 tool:permission:auto）。
  if (subCommands.length > 0 && subCommands.every(subCmd => isRunShellCommandPermitted(tool, subCmd, allowedTools))) {
    return { result: true }
  }

  // AutoRun 档位：子命令未被确定性覆盖时，对整条命令做一次安全判断，判定 safe 直接放行；
  // 判定有风险（或非 AutoRun）则继续转人工申请。
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
      emitAutoApproved(tool, agentId, sessionId, toolId)
      return { result: true }
    }
    logDebug(`[Permission][AutoRun]${tool.name} 判定有风险，转人工申请`)
  }

  // 未完全覆盖 → 转人工。对「首个未被覆盖的子命令」调一次快速模型提取前缀，给出"按前缀授权"选项。
  // 必须用子命令而非整条命令——整条复合命令含 && / || / ; 会被前缀提取提示词判为注入，提取不到前缀。
  // 首个未覆盖子命令过长（如内联脚本 python -c "...大段..."）时跳过前缀提取：提取无意义
  const firstUncovered = subCommands.find(subCmd => !isRunShellCommandPermitted(tool, subCmd, allowedTools)) ?? command
  let prefix: string | null = null
  let allowExact = false
  // 危险命令（含重定向、rm/sudo/mv 等危险首词、find 危险 flag）不提供「按前缀/精确授权」，
  // 只允许单次确认；顺带跳过一次前缀提取模型调用。
  if (!isUnsafeForPrefixAuth(command) && firstUncovered.length <= MAX_PREFIX_EXTRACT_LEN) {
    const info = await getCommandPrefix(firstUncovered, abortController.signal, sessionId)
    checkAbortSignal(abortController)
    if (info === null) {
      // 模型调用失败 → 退化「精确命令授权」run_shell(<完整命令>)（命令 ≤ 64 时），下次同一条命令可放行；
      // 命令 > 64（即便 ≤ 512）则不给 allow，仅单次确认
      allowExact = command.length <= MAX_EXACT_AUTH_LEN
    } else if (info.commandInjectionDetected || !info.commandPrefix) {
      // 检出注入 或 返回 none/git（如 git push）：模型明确判定不宜授权 → 不给 allow，仅单次确认
    } else {
      // 提到有效前缀 → 「按前缀授权」run_shell(<前缀>:*)
      prefix = info.commandPrefix
    }
  }

  // 有前缀 → 按前缀授权；模型失败且命令 ≤ 64 → 精确命令授权；其余（注入/none/命令 > 64/超长）→ 无 allow，仅单次确认
  const showAllow = prefix !== null || allowExact

  return requestPermissionViaEvent(tool, { command, description }, prefix, abortController, agentId, sessionId, toolId, showAllow, true)
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

  // 文件读取 按父目录会话内生效（不持久化），prefix 即父目录
  if (tool.name === TOOL_NAME_VIEW_FILE) {
    if (prefix) getStateManager().session(sessionId).grantExternalReadDir(prefix)
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

  // 历史压缩成紧凑 text 行（只留用户输入 + run_shell/fetch_url/编辑工具摘要），末尾直接追加
  // 同格式的待判断动作行，全部合并进同一条 user 消息：不含裸 tool_use，信号更聚焦。
  const messages = [buildUserMsg([
    ...extractAutoRunContext(history),
    // 动作行与历史工具行同格式（无前缀/包装），最大化连续检查间的前缀缓存复用
    { type: 'text', text: summarizeActionLine(tool.name, input) },
  ])]

  const response = await queryLLM(
    messages,
    [{ type: 'text', text: AUTO_RUN_SAFETY_CONTEXT_SYSTEM_PROMPT }],
    signal,
    [], // 消息里已无任何 tool 块，无需占位工具；空数组会让适配器省略 tools 字段
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

  return parseSafetyVerdict(raw)
}

/**
 * 从安全模型的原始输出中稳健地解析出 safe / risky。
 *
 * 提示词要求整条回复就是一个标签 <verdict>safe|risky</verdict>（结论前置，抗话痨）：
 *  1) 优先取【第一个】<verdict> 标签为准——结论放最前，即便后面又啰嗦也不影响；
 *  2) 没有标签时兜底：快速模型偶发不带标签、夹带思考，取【最后出现】的 safe/risky
 *     关键词（推理结论通常落末尾），并排除 "not safe" 这类紧邻否定；
 *  3) 都匹配不到 → fail-closed 判 risky。
 */
function parseSafetyVerdict(raw: string): 'safe' | 'risky' {
  const text = raw.toLowerCase()

  // 1) 首个 <verdict> 标签
  const tag = text.match(/<verdict>\s*(safe|risky)\s*<\/verdict>/)
  if (tag) return tag[1] === 'safe' ? 'safe' : 'risky'

  // 2) 兜底：最后一个 safe/risky 关键词
  const matches = [...text.matchAll(/\b(safe|risky)\b/g)]
  if (matches.length === 0) return 'risky'

  const last = matches[matches.length - 1]!
  if (last[1] === 'risky') return 'risky'

  // 最后命中的是 safe：排除紧邻的否定（如 "not safe"）
  const before = text.slice(Math.max(0, last.index! - 5), last.index!)
  if (/\bnot\s*$/.test(before)) return 'risky'
  return 'safe'
}

// AutoRun 自动放行结果：approved=是否放行；byModel=是否由快速模型安全判断放行
// （区别于只读/路径/Skill 等确定性放行，仅 byModel=true 才向 UI 发「模型自动放行」事件）。
type AutoApproveOutcome = { approved: boolean; byModel: boolean }

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
): Promise<AutoApproveOutcome> {
  // 文件编辑：确定性判断，不走 LLM
  // 项目内或临时文件放行；其余项目外文件一律转人工，避免模型误判为 safe
  if (isFileEditTool(tool)) {
    const filePath = getFilePath(input)
    const approved = !filePath || isPathInsideRoot(filePath, readInitialCwd()) || isTempFile(filePath)
    return { approved, byModel: false }
  }

  // Skill：本身无副作用（仅注入提示词），技能内的真实动作会作为下游工具再次过权限闸门，直接放行
  if (isSkillTool(tool)) {
    return { approved: true, byModel: false }
  }

  // MCP：外部且不可逆的副作用，下游不再拦截，工具语义对模型不透明，未白名单一律转人工
  if (isMCPTool(tool)) {
    return { approved: false, byModel: false }
  }

  // fetch_url：先做确定性 SSRF 兜底，命中内网/链路本地/元数据等直接转人工，不交给模型
  if (isFetchUrlTool(tool)) {
    const url = ((input as any).url || '').toString()
    if (isBlockedFetchHost(url)) {
      logDebug(`[Permission][AutoRun] fetch_url 命中内网/元数据 denylist，转人工: ${url}`)
      return { approved: false, byModel: false }
    }
  }

  // 其余（fetch_url 通过兜底后等）：交给快速模型判断（run_shell 已在 checkRunShellPermission 中提前判断）
  try {
    const safe = (await classifyActionSafety(tool, input, signal, sessionId, agentId)) === 'safe'
    return { approved: safe, byModel: safe }
  } catch (error) {
    logDebug(`[Permission][AutoRun] 安全判断失败，转人工: ${error}`)
    return { approved: false, byModel: false }
  }
}

// ==================== 权限请求 ====================

/**
 * 发出「模型自动放行」事件，告知 UI 本次放行由快速模型安全判断通过（而非确定性放行）。
 * 仅在快速模型判定 safe 而放行时调用。
 */
function emitAutoApproved(tool: Tool, agentId: string, sessionId: string, toolId: string): void {
  const data: ToolPermissionAutoData = {
    agentId,
    toolId,
    toolName: tool.name,
    content: 'Allowed by model check · auto mode',
  }
  getEventBus().emit('tool:permission:auto', data, sessionId)
}

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
    const outcome = await autoApproveInAutoRun(tool, input, abortController.signal, sessionId, agentId)
    if (outcome.approved) {
      checkAbortSignal(abortController)
      logDebug(`[Permission][AutoRun]${tool.name} 自动放行`)
      // 仅模型判断放行才通知 UI；确定性放行（文件路径/Skill）不发事件
      if (outcome.byModel) emitAutoApproved(tool, agentId, sessionId, toolId)
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

  // 文件读取工具：按父目录会话级授权；无父目录则不提供「允许」
  if (tool.name === TOOL_NAME_VIEW_FILE) {
    if (!prefix) {
      return { agree: '确认', refuse: '拒绝' }
    }
    return {
      agree: '确认',
      allow: `确认，本次会话不再询问 ${prefix} 目录下的读取`,
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
    // SSRF 兜底命中（内网/元数据等）时 showAllow=false：不提供「永久允许域名」，只许单次确认
    if (!showAllow) {
      return { agree: '确认', refuse: '拒绝' }
    }
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
import { Tool } from '../tools/base/Tool'
import { RunShell, toolParams } from '../tools/RunShell'
import { TOOL_NAME_PATCH_FILE as PATCH_FILE_TOOL_NAME, TOOL_NAME_WRITE_FILE as WRITE_FILE_TOOL_NAME, TOOL_NAME_EDIT_NOTEBOOK as EDIT_NOTEBOOK_TOOL_NAME, TOOL_NAME_SKILL, TOOL_NAME_FETCH_URL, TOOL_NAME_VIEW_FILE } from '../prompt/tool'
import { splitCommand, getCommandPrefix } from '../util/commands'
import { readInitialCwd } from '../util/cwd'
import { logDebug, logError, logInfo } from '../util/log'
import { REJECT_MSG, CANCEL_MSG, getCustomFeedbackMessage, API_ERR_PREFIX, buildUserMsg } from '../util/message'
import { getConfManager } from './ConfManager'
import { getEventBus } from '../events/EventSystem'
import { ToolPermissionRequestData, ToolPermissionResponse, ToolPermissionAutoData } from '../events/types'
import { checkAbortSignal } from '../types/errors'
import { getFilePath, canonicalizeFilePath } from '../util/file'
import { addUserWait } from '../util/agentStats'
import { dirname, join } from 'path'
import { getSemaRootDir } from '../util/savePath'
import { classifyReadPath, isAttachmentPath } from '../util/readPathClass'
import { getStateManager, MAIN_AGENT_ID } from './StateManager'
import { queryLLM } from '../services/api/queryLLM'
import { AUTO_RUN_SAFETY_CONTEXT_SYSTEM_PROMPT } from '../prompt/permission'
import { isUnsafeForPrefixAuth, hasNetworkCommand, isLoopbackReadonlyRequest } from '../util/shellSafety'
import { classifyRunShellGate, isRunShellCommandPermitted, isPathInsideRoot, isTempFile } from './runShellGate'
import { extractAutoRunContext, summarizeActionLine } from '../util/autoRunContext'
import { classifyFetchHost } from '../util/fetchSafety'
import { firePermissionRequest } from '../services/hooks/hookTriggers'
import { getSkillsManager } from '../services/skills/skillsManager'
import { t } from '../util/i18n'

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

  // Bypass 档位：所有工具调用直接放行，跳过全部安全检查（危险）
  const runtime = getStateManager().session(sessionId)
  if (runtime.isBypass()) {
    logDebug(`[Permission]${tool.name} Bypass 档位，跳过全部安全检查`)
    return { result: true }
  }

  // 文件编辑工具权限检查
  if (isFileEditTool(tool)) {
    if (coreConfig?.skipFileEditPermission) {
      logDebug(`[Permission]${tool.name} 跳过编辑检查`)
      return {result: true }
    }

    const runtime = getStateManager().session(sessionId)
    if (runtime.hasGlobalEditPermission()) {
      logDebug(`[Permission]${tool.name} hasGlobalEditPermission: True`)
      // 项目内、临时文件、SEMA_ROOT/attachments 直接放行，其余项目外文件需要请求权限
      const filePath = getFilePath(input)
      if (!filePath || isPathInsideRoot(filePath, readInitialCwd()) || isTempFile(filePath) || isAttachmentPath(filePath)) {
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

  // view_file 权限检查：读取位置的全部裁决都在这里完成，工具执行阶段不再因位置报错
  if (tool.name === TOOL_NAME_VIEW_FILE) {
    if (coreConfig?.skipExternalFileReadPermission) {
      logDebug(`[Permission]${tool.name} 跳过读取位置检查`)
      return { result: true }
    }

    const filePath = getFilePath(input)
    if (!filePath) return { result: true }

    const pathClass = classifyReadPath(filePath)

    // 项目内、临时文件或 SEMA_ROOT 受信内容目录：直接放行，保持静默
    if (pathClass === 'trusted') {
      return { result: true }
    }

    // 敏感凭据、其他用户目录、系统目录等：各档位均确定性转人工，不交快速模型（skipAutoRun），
    // 也不提供按目录授权（prefix 为 null），只许单次同意
    if (pathClass === 'restricted') {
      logHumanFallback(tool.name, 'hard-rule', `受限位置读取 ${filePath}`)
      return requestPermissionViaEvent(tool, input, null, abortController, agentId, sessionId, toolId, true, true)
    }

    // 项目外的用户文件 / 公共系统目录：auto 模式（非 Ask）自动放行
    const runtime = getStateManager().session(sessionId)
    if (runtime.hasGlobalEditPermission()) {
      logDebug(`[Permission]${filePath} 项目外读取，auto 模式自动放行`)
      return { result: true }
    }

    // 命中本会话已授权的父目录则放行（敏感/受限位置已在上面先行拦下，不会被目录授权带过）
    const absPath = canonicalizeFilePath(filePath)
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

    // 内置 skill 的正文随 core 提供、非第三方内容，加载说明本身无副作用，直接放行；
    // 其指导下的写文件/执行命令仍各自过权限闸门。按 locate 判断：用户同名 skill 覆盖内置后仍需询问
    if (skillName && getSkillsManager().getSkillConfig(skillName)?.locate === 'builtin') {
      return { result: true }
    }

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
    const hostClass = url ? classifyFetchHost(url) : 'public'

    // blocked（链路本地/元数据/未指定）：即便已保存域名授权也不放行（纵深防御，治存量配置），
    // 转人工时不提供「永久允许该域名」。loopback：不提供永久授权（「记住 localhost」范围过宽），
    // AutoRun 交模型。private / public：可命中已保存域名授权，转人工时可永久允许。
    if (url && hostClass !== 'blocked' && hostClass !== 'loopback') {
      const domain = extractDomain(url)
      if (domain && allowedTools.includes(`${FETCH_URL_TOOL_NAME}(${domain})`)) {
        return { result: true }
      }
    }

    const showAllow = hostClass === 'public' || hostClass === 'private'
    return requestPermissionViaEvent(tool, input, null, abortController, agentId, sessionId, toolId, showAllow)
  }

  logDebug(`[Permission]${tool.name} 非编辑、run_shell、skill、mcp或webfetch工具默认允许`)

  // 其他工具默认允许
  return { result: true }
}

// ==================== run_shell 工具权限检查 ====================

async function checkRunShellPermission(
  tool: Tool,
  rawCommand: string,
  abortController: AbortController,
  allowedTools: string[],
  agentId: string,
  sessionId: string,
  toolId: string,
  description?: string
): Promise<PermissionCheckResult> {
  // 确定性裁决（注入形态 / 白名单 / 危险分级 / 覆盖）全部在 classifyRunShellGate（纯函数，与
  // tests/manager/runShellGate.* 同源）；这里只负责接模型判断、事件与人工申请。
  const gate = classifyRunShellGate(rawCommand, allowedTools)
  const command = gate.command

  if (gate.verdict === 'allow') {
    return { result: true }
  }

  // 确定性转人工：不调模型、不提供前缀/精确授权（showAllow=false）；
  // skipAutoRun=true 跳过 requestPermissionViaEvent 内的 AutoRun 自动放行，避免重复调模型
  if (gate.verdict === 'human') {
    logHumanFallback(tool.name, 'hard-rule', gate.detail)
    return requestPermissionViaEvent(tool, { command, description }, null, abortController, agentId, sessionId, toolId, false, true)
  }

  // 交模型：AutoRun 档位判定 safe 直接放行；判 risky / 失败 / 非 AutoRun 则转人工。
  // 模型放行绝不持久化。
  if (await autoRunModelAllows(tool, { command }, abortController, sessionId, agentId, toolId, gate.detail)) {
    return { result: true }
  }

  // 注入形态 / 灰区危险命令转人工时不提供前缀/精确授权，只许单次确认
  if (gate.stage !== 'uncovered') {
    return requestPermissionViaEvent(tool, { command, description }, null, abortController, agentId, sessionId, toolId, false, true)
  }

  // 未完全覆盖 → 转人工。对「首个未被覆盖的子命令」调一次快速模型提取前缀，给出"按前缀授权"选项。
  // 必须用子命令而非整条命令——整条复合命令含 && / || / ; 会被前缀提取提示词判为注入，提取不到前缀。
  // 首个未覆盖子命令过长（如内联脚本 python -c "...大段..."）时跳过前缀提取：提取无意义
  const subCommands = splitCommand(command)
  const firstUncovered = subCommands.find(subCmd => !isRunShellCommandPermitted(subCmd, allowedTools)) ?? command
  let prefix: string | null = null
  let allowExact = false
  // 危险命令（含重定向、rm/sudo/mv 等危险首词、find 危险 flag、curl/wget 等网络命令）不提供
  // 「按前缀/精确授权」，只允许单次确认；顺带跳过一次前缀提取模型调用。
  // 网络命令例外：对环回地址的只读请求（如 curl localhost:3000/api/health）放宽为「记住这一条完整命令」，
  // 保存 run_shell(<完整命令>)，下次同一条免确认，范围不会外溢。固定规则只决定要不要多给这个选项，
  // 用户仍会看到命令并确认一次，漏判代价很低；AutoRun 档的自动放行仍由上面的模型判断裁决。
  if (hasNetworkCommand(command)) {
    allowExact = isLoopbackReadonlyRequest(command)
  } else if (!isUnsafeForPrefixAuth(command) && firstUncovered.length <= MAX_PREFIX_EXTRACT_LEN) {
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

// 转人工的三类原因，打进日志便于统计哪类弹窗最多：
//  hard-rule    → 确定性规则拦截，未调模型
//  model-risky  → 快速模型判定 risky
//  model-failed → 快速模型调用失败/超时/输出无法解析（重试一次后仍失败）
type HumanFallbackReason = 'hard-rule' | 'model-risky' | 'model-failed'

function logHumanFallback(toolName: string, reason: HumanFallbackReason, detail: string): void {
  logInfo(`[Permission][AutoRun]${toolName} 转人工 reason=${reason} (${detail})`)
}

/**
 * AutoRun 档位下对单个动作做一次快速模型安全判断：判 safe → 发「模型自动放行」事件并返回 true；
 * 判 risky / 调用失败 / 非 AutoRun → 返回 false，由调用方转人工。
 * run_shell 的三处灰区（$() 替换、灰区危险命令、未覆盖命令）共用，避免重复展开。
 */
async function autoRunModelAllows(
  tool: Tool,
  input: ToolInvocationArgs,
  abortController: AbortController,
  sessionId: string,
  agentId: string,
  toolId: string,
  detail: string,
): Promise<boolean> {
  if (!getStateManager().session(sessionId).isAutoRun()) return false
  let verdict: 'safe' | 'risky' | null = null
  try {
    verdict = await classifyActionSafety(tool, input, abortController.signal, sessionId, agentId)
  } catch (error) {
    logDebug(`[Permission][AutoRun] 安全判断失败: ${error}`)
  }
  checkAbortSignal(abortController)
  if (verdict === 'safe') {
    logDebug(`[Permission][AutoRun]${tool.name} ${detail}，模型判定 safe，自动放行`)
    emitAutoApproved(tool, agentId, sessionId, toolId)
    return true
  }
  logHumanFallback(tool.name, verdict === 'risky' ? 'model-risky' : 'model-failed', detail)
  return false
}

/**
 * 调用快速模型判断动作是否安全。
 * API 错误、返回为空或输出无法解析时重试一次；仍失败抛出异常，交由调用方做失败关闭处理
 * （记为 model-failed，与模型判 risky 区分——「默认 safe」是模型的决策倾向，不是接口失败就放行）。
 */
async function classifyActionSafety(
  tool: Tool,
  input: ToolInvocationArgs,
  signal: AbortSignal,
  sessionId?: string,
  agentId: string = MAIN_AGENT_ID,
): Promise<'safe' | 'risky'> {
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const verdict = await queryActionSafety(tool, input, signal, sessionId, agentId)
      if (verdict) return verdict
      lastError = new Error('AutoRun safety verdict unparseable')
    } catch (error) {
      if (signal.aborted) throw error
      lastError = error
    }
    logDebug(`[Permission][AutoRun] 安全判断第 ${attempt + 1} 次失败: ${lastError}`)
  }
  throw lastError
}

async function queryActionSafety(
  tool: Tool,
  input: ToolInvocationArgs,
  signal: AbortSignal,
  sessionId: string | undefined,
  agentId: string,
): Promise<'safe' | 'risky' | null> {
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

  // 真实的 skills 目录（用户级 + 项目级，与 skillsManager 的定位一致）内插进系统提示词：
  // 模型按确切绝对路径判定「skill 自带脚本」，不靠猜 ~/.sema 之类的模式；
  // 路径在会话内恒定，渲染出的提示词字节不变，不破坏前缀缓存
  const skillDirs = [join(getSemaRootDir(), 'skills'), join(readInitialCwd(), '.sema', 'skills')]

  const response = await queryLLM(
    messages,
    [{ type: 'text', text: AUTO_RUN_SAFETY_CONTEXT_SYSTEM_PROMPT(skillDirs) }],
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

  const verdict = parseSafetyVerdict(raw)
  // 动作行与模型原始输出一起进日志：判错时能对照「模型看到了什么、答了什么」，不用盲调提示词
  logInfo(`[Permission][AutoRun] verdict=${verdict ?? 'unparseable'} action=${summarizeActionLine(tool.name, input).slice(0, 200)} raw=${raw.slice(0, 200).replace(/\s+/g, ' ')}`)
  return verdict
}

/**
 * 从安全模型的原始输出中稳健地解析出 safe / risky。
 *
 * 提示词要求整条回复就是一个标签 <verdict>safe|risky</verdict>（结论前置，抗话痨）：
 *  1) 优先取【第一个】<verdict> 标签为准——结论放最前，即便后面又啰嗦也不影响；
 *  2) 没有标签时兜底：快速模型偶发不带标签、夹带思考，取【最后出现】的 safe/risky
 *     关键词（推理结论通常落末尾），并排除 "not safe" 这类紧邻否定；
 *  3) 都匹配不到 → null（输出无法解析，由调用方重试/记为 model-failed）。
 */
function parseSafetyVerdict(raw: string): 'safe' | 'risky' | null {
  const text = raw.toLowerCase()

  // 1) 首个 <verdict> 标签
  const tag = text.match(/<verdict>\s*(safe|risky)\s*<\/verdict>/)
  if (tag) return tag[1] === 'safe' ? 'safe' : 'risky'

  // 2) 兜底：最后一个 safe/risky 关键词
  const matches = [...text.matchAll(/\b(safe|risky)\b/g)]
  if (matches.length === 0) return null

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
 * 1) 确定性：文件编辑只看路径（项目内放行/项目外转人工）；Skill 放行；MCP 只看 destructiveHint 注解——均不走 LLM
 * 2) fetch_url：先做确定性主机分级（链路本地/元数据 blocked、内网 private 直接转人工），环回/公网再交快速模型判断
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
  // 项目内、临时文件、SEMA_ROOT/attachments 放行；其余项目外文件一律转人工，避免模型误判为 safe
  if (isFileEditTool(tool)) {
    const filePath = getFilePath(input)
    const approved = !filePath || isPathInsideRoot(filePath, readInitialCwd()) || isTempFile(filePath) || isAttachmentPath(filePath)
    if (!approved) logHumanFallback(tool.name, 'hard-rule', '项目外文件编辑')
    return { approved, byModel: false }
  }

  // Skill：本身无副作用（仅注入提示词），技能内的真实动作会作为下游工具再次过权限闸门，直接放行
  if (isSkillTool(tool)) {
    return { approved: true, byModel: false }
  }

  // MCP：server 由用户自行安装，默认信任；仅 server 显式标注 destructiveHint=true（且非只读）的工具转人工，
  // 未标注/只读一律放行。注解是 server 自报的提示而非安全边界，工具语义对模型不透明，故不交给快速模型判断
  if (isMCPTool(tool)) {
    const destructive = tool.isDestructive?.() === true
    if (destructive) logHumanFallback(tool.name, 'hard-rule', '标注 destructiveHint')
    return { approved: !destructive, byModel: false }
  }

  // fetch_url：先做确定性主机分级。blocked（链路本地/元数据/未指定）与 private（内网）直接转人工，
  // 不交模型——前者是 SSRF 边界，后者语义对模型不透明但用户可永久允许域名；环回与公网交模型
  if (isFetchUrlTool(tool)) {
    const url = ((input as any).url || '').toString()
    const hostClass = classifyFetchHost(url)
    if (hostClass === 'blocked' || hostClass === 'private') {
      logHumanFallback(tool.name, 'hard-rule', `${hostClass} 主机 ${url}`)
      return { approved: false, byModel: false }
    }
  }

  // 其余（fetch_url 通过分级后等）：交给快速模型判断（run_shell 已在 checkRunShellPermission 中提前判断）
  try {
    const verdict = await classifyActionSafety(tool, input, signal, sessionId, agentId)
    if (verdict === 'risky') logHumanFallback(tool.name, 'model-risky', '')
    return { approved: verdict === 'safe', byModel: verdict === 'safe' }
  } catch (error) {
    logDebug(`[Permission][AutoRun] 安全判断失败: ${error}`)
    logHumanFallback(tool.name, 'model-failed', '')
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
    content: t('permission.autoApproved'),
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

  // PermissionRequest hook：权限系统即将向用户发起询问前触发（AutoRun 自动放行不算询问）。
  // allow → 等价用户 agree（不落盘 savePermission，不产生永久授权）；
  // deny → 走自定义反馈不中断通道（自动策略拒单个动作，模型可换方案，不 abort 整个 turn）；
  // ask/无输出/hook 失败 → 继续原询问流程
  const hookOutcome = await firePermissionRequest(sessionId, agentId, tool.name, input, abortController.signal)
  if (hookOutcome.decision === 'allow') {
    checkAbortSignal(abortController)
    logInfo(`[Permission][Hook]${tool.name} 由 PermissionRequest hook 放行`)
    return { result: true }
  }
  if (hookOutcome.decision === 'deny') {
    checkAbortSignal(abortController)
    logInfo(`[Permission][Hook]${tool.name} 被 PermissionRequest hook 拒绝`)
    return {
      result: false,
      message: getCustomFeedbackMessage(hookOutcome.reason || 'Denied by PermissionRequest hook'),
    }
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
  const waitStart = Date.now()
  eventBus.emit('tool:permission:request', requestData, sessionId)

  return new Promise<PermissionCheckResult>((resolve) => {
    // 清理函数：移除所有监听器，并把本次等待用户的时长记账（执行耗时统计时扣除）
    const disposeHandle = () => {
      eventBus.off('tool:permission:response', handleResponse)
      abortController.signal.removeEventListener('abort', onAbortRequested)
      addUserWait(sessionId, agentId, Date.now() - waitStart)
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
  // 文案按当前 lang 输出（见 util/i18n）
  const agree = t('permission.agree')
  const refuse = t('permission.refuse')

  // run_shell工具
  if (tool.name === RunShell.name) {
    const command = ((input as any).command || '').trim()

    if (!showAllow) {
      return { agree, refuse }
    }

    if (prefix) {
      return {
        agree,
        allow: t('permission.allowShellPrefix', { prefix }),
        refuse
      }
    }

    const allowText = command
      ? t('permission.allowShellExact', { command })
      : t('permission.allowShellThis')

    return { agree, allow: allowText, refuse }
  }

  // 编辑工具
  if (isFileEditTool(tool)) {
    return {
      agree,
      allow: t('permission.allowEdit'),
      refuse
    }
  }

  // 文件读取工具：按父目录会话级授权；无父目录（受限位置）则不提供「允许」
  if (tool.name === TOOL_NAME_VIEW_FILE) {
    if (!prefix) {
      return { agree, refuse }
    }
    return {
      agree,
      allow: t('permission.allowReadDir', { dir: prefix }),
      refuse
    }
  }

  // Skill 工具
  if (isSkillTool(tool)) {
    const skillName = (input as any).skill || ''
    return {
      agree,
      allow: skillName
        ? t('permission.allowSkill', { skill: skillName })
        : t('permission.allowSkillAny'),
      refuse
    }
  }

  // MCP 工具
  if (isMCPTool(tool)) {
    return {
      agree,
      allow: t('permission.allowMcp', { tool: tool.name }),
      refuse
    }
  }

  // fetch_url 工具
  if (isFetchUrlTool(tool)) {
    // blocked（链路本地/元数据）/ loopback 主机 showAllow=false：不提供「永久允许域名」，只许单次确认
    if (!showAllow) {
      return { agree, refuse }
    }
    const url = (input as any).url || ''
    const domain = extractDomain(url)
    return {
      agree,
      allow: domain
        ? t('permission.allowFetchDomain', { domain })
        : t('permission.allowFetchThis'),
      refuse
    }
  }

  return {
    agree: t('permission.approve'),
    allow: t('permission.allowGeneric', { tool: tool.name }),
    refuse
  }
}
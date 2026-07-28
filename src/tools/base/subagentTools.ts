import { Tool } from './Tool'
import { getAvailableBuiltinTools, getToolSearchDefaultNames, isValidMCPWildcard, SUBAGENT_EXCLUDED_TOOLS } from './tools'
import { getMCPManager } from '../../services/mcp/MCPManager'
import { getConfManager } from '../../manager/ConfManager'
import { getStateManager } from '../../manager/StateManager'
import { createSubagentLoadTools } from '../LoadTools'
import { TOOL_NAME_RUN_SHELL } from '../../prompt/tool'
import type { AgentConfig } from '../../types/agent'

// 子代理的 run_shell 不支持后台执行：omit background，模型不可见此字段
function omitRunShellBackground(tools: Tool[]): Tool[] {
  return tools.map(t => {
    if (t.name === TOOL_NAME_RUN_SHELL) {
      return { ...t, toolParams: (t.toolParams as any).omit({ background: true }) }
    }
    return t
  })
}

// 显式声明的 tools 中匹配 MCP 工具：精确全名 mcp__{server}__{tool}，或通配 mcp__{server}__* / mcp__{server}__{prefix}*
// 不合法通配（mcp__*、mcp__{server}* 等未具体到 server 的形式）直接丢弃
function matchDeclaredMCPTools(declared: string[], mcpTools: Tool[]): Tool[] {
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const name of declared) {
    if (!name.startsWith('mcp__')) continue
    if (name.endsWith('*')) {
      if (isValidMCPWildcard(name)) prefixes.push(name.slice(0, -1))
      continue
    }
    exact.add(name)
  }
  if (exact.size === 0 && prefixes.length === 0) return []
  return mcpTools.filter(t => exact.has(t.name) || prefixes.some(p => t.name.startsWith(p)))
}

/**
 * 组装子代理工具集，并返回重组闭包（供 tools_loaded 重建上下文时使用）。
 * 显式声明的 agent 声明即所得（内置与 core 级 useTools 求交 + 声明匹配的 MCP），与工具搜索模式无关；
 * '*' 时工具搜索模式收敛为默认集并注入 load_tools，自加载状态存 agent 级、随子代理结束清理。
 * rebuildTools 为 append-only：前段冻结在闭包里，仅自加载段增长，保证子代理前缀缓存稳定。
 */
export function buildSubagentToolset(
  agentConfig: AgentConfig,
  sessionId: string,
  agentId: string,
): { tools: Tool[]; rebuildTools: () => Tool[] } {
  const runtime = getStateManager().session(sessionId)
  const coreUseTools = getConfManager().getCoreConfig()?.useTools
  const hasExplicitTools = !!agentConfig.tools && agentConfig.tools !== '*'
  const mcpTools = getMCPManager().getMCPTools()

  let builtinTools: Tool[]
  if (hasExplicitTools) {
    const declared = agentConfig.tools as string[]
    const effective = coreUseTools ? declared.filter(name => coreUseTools.includes(name)) : declared
    builtinTools = getAvailableBuiltinTools([...effective])
  } else {
    builtinTools = getAvailableBuiltinTools(coreUseTools)
  }
  builtinTools = omitRunShellBackground(builtinTools.filter(t => !SUBAGENT_EXCLUDED_TOOLS.has(t.name)))

  if (hasExplicitTools) {
    const declaredMCP = matchDeclaredMCPTools(agentConfig.tools as string[], mcpTools)
    const tools = declaredMCP.length > 0 ? [...builtinTools, ...declaredMCP] : builtinTools
    return { tools, rebuildTools: () => tools }
  }

  const enableToolSearch = getConfManager().getCoreConfig()?.enableToolSearch ?? false

  if (!enableToolSearch) {
    const tools = mcpTools.length > 0 ? [...builtinTools, ...mcpTools] : builtinTools
    return { tools, rebuildTools: () => tools }
  }

  // 工具搜索模式：默认集 + 继承父会话已加载（spawn 时快照，防父代理并发 load 导致继承段漂移）
  const byName = new Map<string, Tool>()
  builtinTools.forEach(t => byName.set(t.name, t))
  mcpTools.forEach(t => byName.set(t.name, t))

  // 默认集按白名单序从内置 ∪ MCP 取（与主代理一致，含配置的 MCP 默认工具）；排除工具不在 byName 中自然丢弃
  const defaultNameList = getToolSearchDefaultNames(coreUseTools)
  const defaultNames = new Set(defaultNameList)
  const base = defaultNameList
    .map(name => byName.get(name))
    .filter((t): t is Tool => !!t)
  const inherited = runtime.getLoadedToolNames()
    .filter(name => !defaultNames.has(name) && !SUBAGENT_EXCLUDED_TOOLS.has(name))
    .map(name => byName.get(name))
    .filter((t): t is Tool => !!t)

  const staticToolNames = [...base.map(t => t.name), ...inherited.map(t => t.name)]
  const staticNameSet = new Set(staticToolNames)

  // 子代理延迟池 = (可用内置 ∪ MCP) \ SUBAGENT_EXCLUDED_TOOLS \ 已在列表（MCP 实时读取）
  const getDeferredPool = (): Tool[] => {
    const pool = new Map<string, Tool>()
    getAvailableBuiltinTools(coreUseTools).forEach(t => pool.set(t.name, t))
    getMCPManager().getMCPTools().forEach(t => pool.set(t.name, t))
    return omitRunShellBackground(
      [...pool.values()].filter(t => !SUBAGENT_EXCLUDED_TOOLS.has(t.name) && !staticNameSet.has(t.name))
    )
  }

  // 延迟池为空时不注入 load_tools（对齐主代理短路逻辑）
  if (getDeferredPool().length === 0) {
    const tools = [...base, ...inherited]
    return { tools, rebuildTools: () => tools }
  }

  const loadToolsInstance = createSubagentLoadTools({ sessionId, agentId, staticToolNames, getDeferredPool })

  const resolveOwnLoaded = (): Tool[] => {
    const poolByName = new Map(getDeferredPool().map(t => [t.name, t]))
    return runtime.getAgentLoadedToolNames(agentId)
      .map(name => poolByName.get(name))
      .filter((t): t is Tool => !!t)
  }
  const rebuildTools = () => [...base, loadToolsInstance, ...inherited, ...resolveOwnLoaded()]
  return { tools: rebuildTools(), rebuildTools }
}

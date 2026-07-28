import { z } from 'zod'
import { Tool } from './base/Tool'
import { ToolControlSignal } from '../types/message'
import { TOOL_NAME_LOAD_TOOLS } from '../prompt/tool'
import { getStateManager } from '../manager/StateManager'
import { getDeferredTools, getToolSearchDefaultNames } from './base/tools'

const TOOL_NAME = TOOL_NAME_LOAD_TOOLS

const toolParams = z.strictObject({
  tool_names: z.array(z.string()).min(1).max(10).describe('Exact tool names to load, as listed in the tool description. Built-in tools: the name as-is; MCP tools: the full name mcp__{server}__{tool}.'),
})

type ToolRes = {
  loaded: string[]
  alreadyAvailable: string[]
  notFound: string[]
  scope?: string  // 全部未命中时返回的可加载名单，帮助模型纠正名字
  controlSignal?: ToolControlSignal
}

// 可加载名单：延迟内置工具名 + 各 MCP server 的工具原名（全名 = mcp__{server}__{tool}）
function buildScopeOverview(): string {
  const deferred = getDeferredTools()
  const builtinNames: string[] = []
  const mcpByServer = new Map<string, string[]>()
  for (const tool of deferred) {
    if (tool.name.startsWith('mcp__')) {
      const parts = tool.name.split('__')
      const server = parts[1] || 'unknown'
      const origName = parts.length >= 3 ? parts.slice(2).join('__') : tool.name
      if (!mcpByServer.has(server)) mcpByServer.set(server, [])
      mcpByServer.get(server)!.push(origName)
    } else {
      builtinNames.push(tool.name)
    }
  }

  const lines: string[] = []
  if (builtinNames.length > 0) {
    lines.push(`Deferred built-in tools: ${builtinNames.join(', ')}`)
  }
  if (mcpByServer.size > 0) {
    lines.push('MCP server tools (full name = mcp__{server}__{tool}):')
    for (const [server, names] of mcpByServer) {
      lines.push(`- ${server}: ${names.join(', ')}`)
    }
  }
  return lines.join('\n')
}

export const LoadTools = {
  name: TOOL_NAME,
  description() {
    return [
      'Load deferred tools that are not yet in your tool list. ',
      'Loaded tools are appended to your available tools and can be called starting from the next turn. ',
      'Tools already in your list never need loading.\n\n',
      'Pick names from the list below. Built-in tools: use the name as-is. ',
      'MCP tools: use the full name mcp__{server}__{tool}.\n\n',
      buildScopeOverview(),
    ].join('')
  },
  toolParams,
  isSafe() {
    return true
  },
  getDisplayTitle(input?: z.infer<typeof toolParams>) {
    return input?.tool_names?.length ? `${TOOL_NAME}: "${input.tool_names.join(', ')}"` : TOOL_NAME
  },
  async *call({ tool_names }: z.infer<typeof toolParams>, agentContext: any) {
    const runtime = getStateManager().session(agentContext.sessionId)
    const deferredByName = new Map(getDeferredTools().map(tool => [tool.name, tool]))
    const defaultNames = new Set(getToolSearchDefaultNames())
    const loadedBefore = new Set(runtime.getLoadedToolNames())

    // 逐名校验：延迟池中存在 → 加载；已在工具列表（默认集或已加载） → 提示直接调用；否则回报未找到
    const toLoad: string[] = []
    const alreadyAvailable: string[] = []
    const notFound: string[] = []
    const seen = new Set<string>()
    for (const raw of tool_names) {
      const name = raw.trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      if (deferredByName.has(name)) {
        if (loadedBefore.has(name)) {
          alreadyAvailable.push(name)
        } else {
          toLoad.push(name)
        }
      } else if (defaultNames.has(name)) {
        alreadyAvailable.push(name)
      } else {
        notFound.push(name)
      }
    }

    const addedNames = toLoad.length > 0 ? runtime.addLoadedTools(toLoad) : []

    const data: ToolRes = {
      loaded: toLoad,
      alreadyAvailable,
      notFound,
      ...(notFound.length > 0 && toLoad.length === 0 && alreadyAvailable.length === 0
        ? { scope: buildScopeOverview() }
        : {}),
      // 仅有真实新增时才触发工具集重建，避免空转
      ...(addedNames.length > 0 ? { controlSignal: { rebuildContext: { reason: 'tools_loaded' as const } } } : {}),
    }

    yield {
      type: 'result' as const,
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant(output: ToolRes): string {
    const parts: string[] = []
    if (output.loaded.length > 0) {
      parts.push(`Loaded ${output.loaded.length} tool(s), available starting from the next turn: ${output.loaded.join(', ')}`)
    }
    if (output.alreadyAvailable.length > 0) {
      parts.push(`Already in your tool list (call directly): ${output.alreadyAvailable.join(', ')}`)
    }
    if (output.notFound.length > 0) {
      parts.push(`Not found (use exact names from the ${TOOL_NAME} description): ${output.notFound.join(', ')}`)
    }
    if (output.scope) {
      parts.push('Loadable tools:')
      parts.push(output.scope)
    }
    return parts.join('\n')
  },
} satisfies Tool<typeof toolParams, ToolRes>

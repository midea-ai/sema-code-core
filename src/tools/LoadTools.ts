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

// 可加载名单排版：延迟内置工具名 + 各 MCP server 的工具原名（全名 = mcp__{server}__{tool}）
function formatScopeOverview(deferred: Tool[]): string {
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

// 主代理视角的可加载名单（会话级延迟池）
function buildScopeOverview(): string {
  return formatScopeOverview(getDeferredTools())
}

function buildDescription(scopeOverview: string): string {
  return [
    'Load deferred tools that are not yet in your tool list. ',
    'Loaded tools are appended to your available tools and can be called starting from the next turn. ',
    'Tools already in your list never need loading.\n\n',
    'Pick names from the list below. Built-in tools: use the name as-is. ',
    'MCP tools: use the full name mcp__{server}__{tool}.\n\n',
    scopeOverview,
  ].join('')
}

type ClassifyContext = {
  deferredByName: Map<string, Tool>       // 当前视角延迟池
  availableNames: Set<string>             // 已在工具列表、无需加载的名字（不含动态加载段，后者由 loadedBefore 覆盖）
  loadedBefore: Set<string>               // 已动态加载的名字
  addLoaded: (names: string[]) => string[]
  scopeOverview: () => string
}

// 逐名校验：延迟池中存在 → 加载；已在工具列表（默认集或已加载） → 提示直接调用；否则回报未找到
function classifyAndLoad(toolNames: string[], ctx: ClassifyContext): ToolRes {
  const toLoad: string[] = []
  const alreadyAvailable: string[] = []
  const notFound: string[] = []
  const seen = new Set<string>()
  for (const raw of toolNames) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    if (ctx.deferredByName.has(name)) {
      if (ctx.loadedBefore.has(name)) {
        alreadyAvailable.push(name)
      } else {
        toLoad.push(name)
      }
    } else if (ctx.availableNames.has(name)) {
      alreadyAvailable.push(name)
    } else {
      notFound.push(name)
    }
  }

  const addedNames = toLoad.length > 0 ? ctx.addLoaded(toLoad) : []

  return {
    loaded: toLoad,
    alreadyAvailable,
    notFound,
    ...(notFound.length > 0 && toLoad.length === 0 && alreadyAvailable.length === 0
      ? { scope: ctx.scopeOverview() }
      : {}),
    // 仅有真实新增时才触发工具集重建，避免空转
    ...(addedNames.length > 0 ? { controlSignal: { rebuildContext: { reason: 'tools_loaded' as const } } } : {}),
  }
}

export const LoadTools = {
  name: TOOL_NAME,
  description() {
    return buildDescription(buildScopeOverview())
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
    const data = classifyAndLoad(tool_names, {
      deferredByName: new Map(getDeferredTools().map(tool => [tool.name, tool])),
      availableNames: new Set(getToolSearchDefaultNames()),
      loadedBefore: new Set(runtime.getLoadedToolNames()),
      addLoaded: names => runtime.addLoadedTools(names),
      scopeOverview: buildScopeOverview,
    })

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

// 子代理专用 load_tools 包装实例：以子代理视角计算延迟池，加载状态存 agent 级、随子代理结束清理

export function createSubagentLoadTools(opts: {
  sessionId: string
  agentId: string
  /** spawn 时快照：默认集 + 继承段的名字（已在列表，无需加载） */
  staticToolNames: string[]
  /** 子代理视角延迟池（未扣除自身已加载段） */
  getDeferredPool: () => Tool[]
}): Tool {
  const staticNames = new Set(opts.staticToolNames)
  const agentState = () => getStateManager().session(opts.sessionId).forAgent(opts.agentId)
  const scopeOverview = () => {
    const loaded = new Set(agentState().getLoadedToolNames())
    return formatScopeOverview(opts.getDeferredPool().filter(tool => !loaded.has(tool.name)))
  }

  return {
    ...LoadTools,
    description() {
      return buildDescription(scopeOverview())
    },
    async *call({ tool_names }: z.infer<typeof toolParams>, _agentContext: any) {
      const data = classifyAndLoad(tool_names, {
        deferredByName: new Map(opts.getDeferredPool().map(tool => [tool.name, tool])),
        availableNames: staticNames,
        loadedBefore: new Set(agentState().getLoadedToolNames()),
        addLoaded: names => agentState().addLoadedTools(names),
        scopeOverview,
      })

      yield {
        type: 'result' as const,
        data,
        resultForAssistant: LoadTools.genResultForAssistant(data),
      }
    },
  } as any as Tool
}

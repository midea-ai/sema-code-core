import Anthropic from '@anthropic-ai/sdk'
import { Tool } from './Tool'
import {
  TOOL_NAME_RUN_SHELL, TOOL_NAME_SUB_AGENT,
  TOOL_NAME_PEEK_BG_JOB, TOOL_NAME_STOP_BG_JOB,
  TOOL_NAME_PICK_OPTION, TOOL_NAME_PLAN_TO_AGENT,
  TOOL_NAME_CREATE_TODO, TOOL_NAME_GET_TODO,
  TOOL_NAME_LIST_TODOS, TOOL_NAME_UPDATE_TODO,
  TOOL_NAME_LOAD_TOOLS, TOOL_SEARCH_DEFAULT_TOOLS,
} from '../../prompt/tool'
import { RunShell } from '../RunShell'
import { PatchFile } from '../PatchFile'
import { ViewFile } from '../ViewFile'
import { WriteFile } from '../WriteFile'
import { SearchFiles } from '../SearchFiles'
import { SearchContent } from '../SearchContent'
import { EditNotebook } from '../EditNotebook'
import { Skill } from '../Skill'
import { SubAgent } from '../SubAgent'
import { PickOption } from '../PickOption'
import { PlanToAgent } from '../PlanToAgent'
import { PeekBgJob } from '../PeekBgJob'
import { StopBgJob } from '../StopBgJob'
import { CreateTodo } from '../CreateTodo'
import { GetTodo } from '../GetTodo'
import { ListTodos } from '../ListTodos'
import { UpdateTodo } from '../UpdateTodo'
import { CreateCron } from '../CreateCron'
import { DelCron } from '../DelCron'
import { ListCrons } from '../ListCrons'
import { FetchUrl } from '../FetchUrl'
import { LoadTools } from '../LoadTools'
import { getMCPManager } from '../../services/mcp/MCPManager'
import { getConfManager } from '../../manager/ConfManager'
import { getStateManager } from '../../manager/StateManager'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { memoize } from 'lodash-es'
import { ToolInfo } from '../../types/index'
import { logInfo, logWarn } from '../../util/log'


const BG_TOOLS = new Set([TOOL_NAME_RUN_SHELL, TOOL_NAME_SUB_AGENT])

// 子代理中禁用的工具（防止嵌套调用、任务管理等）
export const SUBAGENT_EXCLUDED_TOOLS = new Set([
  TOOL_NAME_SUB_AGENT, TOOL_NAME_PEEK_BG_JOB, TOOL_NAME_STOP_BG_JOB,
  TOOL_NAME_PICK_OPTION, TOOL_NAME_PLAN_TO_AGENT,
  TOOL_NAME_CREATE_TODO, TOOL_NAME_GET_TODO,
  TOOL_NAME_LIST_TODOS, TOOL_NAME_UPDATE_TODO,
  TOOL_NAME_LOAD_TOOLS,
])


// 将工具对象安全转换为 Tool 类型（各工具的字面量类型与 Tool 泛型不完全匹配）
const asTool = (tool: any): Tool => tool

// 获取全部内置工具信息（含启用/禁用状态）
// useTools 不传时回退到全局默认配置
export const getAllBuiltinToolInfos = (useTools?: string[] | null): ToolInfo[] => {
  if (useTools === undefined) {
    useTools = getConfManager().getCoreConfig()?.useTools
  }
  return getBuiltinTools().map(tool => ({
    name: tool.name,
    description: getToolDescription(tool),
    status: (!useTools || useTools.includes(tool.name)) ? 'enable' : 'disable'
  }))
}

// 获取全部内置工具名称（黑名单转白名单等场景的单一真值来源）
export const getAllBuiltinToolNames = (): string[] => getBuiltinTools().map(tool => tool.name)

// 获取全部内置工具
export const getBuiltinTools = (): Tool[] => {
  return [
    RunShell,
    SearchFiles,
    SearchContent,
    ViewFile,
    WriteFile,
    PatchFile,
    FetchUrl,
    SubAgent,
    PeekBgJob,
    StopBgJob,
    Skill,
    EditNotebook,
    PickOption,
    PlanToAgent,
    CreateTodo,
    GetTodo,
    ListTodos,
    UpdateTodo,
    CreateCron,
    DelCron,
    ListCrons,
  ].map(asTool)
}

// 获取可用内置工具（按 useTools 配置过滤）
export const getAvailableBuiltinTools = memoize(
  (useTools?: string[] | null): Tool[] => {
    const allTools = getBuiltinTools()

    if (!useTools) {
      return allTools
    }

    return allTools.filter(tool => useTools.includes(tool.name))
  },
  (useTools?: string[] | null) => {
    if (!useTools) {
      return 'all-tools'
    }
    return useTools.sort().join(',')
  }
)

// 工具搜索模式：解析默认加载的工具名白名单（配置未设置时用内置默认集）
// 仅内置名与 useTools 取交集（core 级 useTools 只含内置工具名）；未知名 warn 后忽略
// 支持 mcp__{server}__* 通配符：展开为该 server 当前全部工具（server 名用工具全名中的规范形式，冒号已转下划线）
export function getToolSearchDefaultNames(useTools?: string[] | null): string[] {
  const configured = getConfManager().getCoreConfig()?.toolSearchDefaultTools
  const names = (configured && configured.length > 0) ? configured : TOOL_SEARCH_DEFAULT_TOOLS
  const builtinNames = new Set(getAllBuiltinToolNames())
  const hasWildcard = names.some(name => name.startsWith('mcp__') && name.endsWith('__*'))
  const mcpNames: string[] = hasWildcard
    ? getMCPManager().getMCPTools().map(tool => tool.name)
    : []
  const result: string[] = []
  const push = (name: string) => {
    if (!result.includes(name)) result.push(name)
  }
  for (const name of names) {
    if (name === TOOL_NAME_LOAD_TOOLS || result.includes(name)) continue
    if (name.startsWith('mcp__') && name.endsWith('__*')) {
      const prefix = name.slice(0, -1)  // 'mcp__{server}__'
      mcpNames.filter(mcpName => mcpName.startsWith(prefix)).forEach(push)
      continue
    }
    if (!builtinNames.has(name) && !name.startsWith('mcp__')) {
      logWarn(`toolSearchDefaultTools 含未知工具名，已忽略: ${name}`)
      continue
    }
    if (useTools && builtinNames.has(name) && !useTools.includes(name)) continue
    push(name)
  }
  return result
}

// 工具搜索模式：延迟池（未默认加载的内置可用工具 + MCP 工具），供 load_tools 加载
export function getDeferredTools(useTools?: string[] | null): Tool[] {
  if (useTools === undefined) {
    useTools = getConfManager().getCoreConfig()?.useTools
  }
  const defaultNames = new Set(getToolSearchDefaultNames(useTools))
  const all = [...getAvailableBuiltinTools(useTools), ...getMCPManager().getMCPTools()]
  return all.filter(tool => !defaultNames.has(tool.name))
}

// 获取可用内置工具 + MCP 工具
// useTools 不传时回退到全局默认配置
// opts.sessionId：工具搜索模式下用于读取会话已动态加载的工具；开关关闭或未传时走原路径
export function getAvailableTools(useTools?: string[] | null, opts?: { sessionId?: string }): Tool[] {
  if (useTools === undefined) {
    useTools = getConfManager().getCoreConfig()?.useTools
  }
  const builtinTools = getAvailableBuiltinTools(useTools)
  const mcpTools = getMCPManager().getMCPTools()
  const enableToolSearch = getConfManager().getCoreConfig()?.enableToolSearch ?? false

  if (!enableToolSearch || !opts?.sessionId) {
    const tools: Tool[] = [...builtinTools, ...mcpTools]
    logInfo(`tools len: ${tools.length} (builtin: ${builtinTools.length}, mcp: ${mcpTools.length})`)
    return tools
  }

  // 工具搜索模式：[默认加载工具(白名单序)] + [load_tools] + [会话已加载工具(加载序)]
  // 顺序 append-only，保证 LLM 前缀缓存稳定
  const byName = new Map<string, Tool>()
  builtinTools.forEach(tool => byName.set(tool.name, tool))
  mcpTools.forEach(tool => byName.set(tool.name, tool))

  const defaultNames = getToolSearchDefaultNames(useTools)
  const defaultTools = defaultNames
    .map(name => byName.get(name))
    .filter((tool): tool is Tool => !!tool)

  // 白名单已覆盖全部可用工具：无延迟池，不注入搜索工具
  if (defaultTools.length === byName.size) {
    return defaultTools
  }

  const loadedNames = getStateManager().session(opts.sessionId).getLoadedToolNames()
  const loadedTools = loadedNames
    .filter(name => !defaultNames.includes(name))
    .map(name => byName.get(name))
    .filter((tool): tool is Tool => !!tool)

  const tools: Tool[] = [...defaultTools, asTool(LoadTools), ...loadedTools]
  logInfo(`tools len: ${tools.length} (tool-search on, default: ${defaultTools.length}, loaded: ${loadedTools.length})`)
  return tools
}


// 从 zod schema 中提取 required 字段
function extractRequiredFields(schema: any): string[] {
  if (!schema || typeof schema !== 'object') return []

  if (schema._def && schema._def.shape) {
    const shape = schema._def.shape()
    return Object.entries(shape)
      .filter(([_, fieldSchema]: [string, any]) => {
        return !fieldSchema.isOptional()
      })
      .map(([fieldName]) => fieldName)
  }

  if (schema.properties) {
    return schema.required || []
  }

  return []
}

// 使用 memoize 优化的 buildTools 函数
export const buildTools = memoize(
  (tools: Tool[]): Anthropic.Tool[] => {
    const disableBackgroundTasks = getConfManager().getCoreConfig()?.disableBackgroundTasks ?? false
    return tools.map(tool => {
      const jsonSchema = zodToJsonSchema(tool.toolParams as any);
      const requiredFields = extractRequiredFields(tool.toolParams);

      // 安全地获取 properties
      let properties = (jsonSchema && typeof jsonSchema === 'object' && 'properties' in jsonSchema)
        ? { ...(jsonSchema.properties as Record<string, unknown>) }
        : jsonSchema

      // 禁用后台任务时，从 run_shell/sub_agent 的 schema 中过滤 background
      if (disableBackgroundTasks && BG_TOOLS.has(tool.name) && properties && typeof properties === 'object') {
        const { background: _, ...rest } = properties as Record<string, unknown>
        properties = rest
      }

      return {
        name: tool.name,
        description: getToolDescription(tool),
        input_schema: {
          type: 'object',
          properties: properties,
          required: requiredFields
        }
      }
    })
  },
  (tools: Tool[]) => {
    const disableBackgroundTasks = getConfManager().getCoreConfig()?.disableBackgroundTasks ?? false
    // key 不排序：工具搜索模式下不同会话可能以不同顺序加载相同工具集合，
    // 排序会让二者命中同一缓存条目导致 tools 数组重排，破坏 LLM 前缀缓存
    let key = tools.map(tool => tool.name).join(',') + (disableBackgroundTasks ? ':no-bg' : '')
    // load_tools 的描述（可加载名单）随 MCP server 连接状态动态变化，用长度作指纹避免缓存陈旧描述
    const loadTool = tools.find(tool => tool.name === TOOL_NAME_LOAD_TOOLS)
    if (loadTool) {
      key += `:ts-${getToolDescription(loadTool).length}`
    }
    return key
  }
)

// 辅助函数：获取工具描述
export function getToolDescription(tool: Tool): string {
  if (typeof tool.description === 'function') {
    return tool.description()
  }
  return tool.description || ''
}
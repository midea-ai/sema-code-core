import Anthropic from '@anthropic-ai/sdk'
import { Tool } from './Tool'
import {
  TOOL_NAME_RUN_SHELL, TOOL_NAME_SUB_AGENT,
  TOOL_NAME_PEEK_BG_JOB, TOOL_NAME_STOP_BG_JOB,
  TOOL_NAME_PICK_OPTION, TOOL_NAME_PLAN_TO_AGENT,
  TOOL_NAME_CREATE_TODO, TOOL_NAME_GET_TODO,
  TOOL_NAME_LIST_TODOS, TOOL_NAME_UPDATE_TODO,
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
import { getMCPManager } from '../../services/mcp/MCPManager'
import { getConfManager } from '../../manager/ConfManager'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { memoize } from 'lodash-es'
import { ToolInfo } from '../../types/index'
import { logInfo } from '../../util/log'


const BG_TOOLS = new Set([TOOL_NAME_RUN_SHELL, TOOL_NAME_SUB_AGENT])

// 子代理中禁用的工具（防止嵌套调用、任务管理等）
export const SUBAGENT_EXCLUDED_TOOLS = new Set([
  TOOL_NAME_SUB_AGENT, TOOL_NAME_PEEK_BG_JOB, TOOL_NAME_STOP_BG_JOB,
  TOOL_NAME_PICK_OPTION, TOOL_NAME_PLAN_TO_AGENT,
  TOOL_NAME_CREATE_TODO, TOOL_NAME_GET_TODO,
  TOOL_NAME_LIST_TODOS, TOOL_NAME_UPDATE_TODO,
])


// 将工具对象安全转换为 Tool 类型（各工具的字面量类型与 Tool 泛型不完全匹配）
const asTool = (tool: any): Tool => tool

// 获取全部内置工具信息（含启用/禁用状态）
export const getAllBuiltinToolInfos = (): ToolInfo[] => {
  const useTools = getConfManager().getCoreConfig()?.useTools
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

// 获取可用内置工具 + MCP 工具
export function getAvailableTools(): Tool[] {
  const useTools = getConfManager().getCoreConfig()?.useTools
  const builtinTools = getAvailableBuiltinTools(useTools)
  const mcpTools = getMCPManager().getMCPTools()
  const tools: Tool[] = [...builtinTools, ...mcpTools]
  logInfo(`tools len: ${tools.length} (builtin: ${builtinTools.length}, mcp: ${mcpTools.length})`)
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
    return tools.map(tool => tool.name).sort().join(',') + (disableBackgroundTasks ? ':no-bg' : '')
  }
)

// 辅助函数：获取工具描述
export function getToolDescription(tool: Tool): string {
  if (typeof tool.description === 'function') {
    return tool.description()
  }
  return tool.description || ''
}
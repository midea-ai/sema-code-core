import Anthropic from '@anthropic-ai/sdk'
import { Tool } from './Tool'
import { BashTool } from '../Bash/Bash'
import { FileEditTool } from '../Edit/Edit'
import { FileReadTool } from '../Read/Read'
import { FileWriteTool } from '../Write/Write'
import { GlobTool } from '../Glob/Glob'
import { GrepTool } from '../Grep/Grep'
import { NotebookEditTool } from '../NotebookEdit/NotebookEdit'
import { TodoWriteTool } from '../TodoWrite/TodoWrite'
import { SkillTool } from '../Skill/Skill'
import { TaskTool } from '../Task/Task'
import { AskUserQuestionTool } from '../AskUserQuestion/AskUserQuestion'
import { ExitPlanModeTool } from '../ExitPlanMode/ExitPlanMode'
import { getConfManager } from '../../manager/ConfManager'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { memoize } from 'lodash-es'
import { ToolInfo } from '../../types/index'


// 获取所有工具信息（内置工具）
export const getToolInfos = (): ToolInfo[] => {
  const useTools = getConfManager().getCoreConfig()?.useTools
  return getBuiltinTools().map(tool => ({
    name: tool.name,
    description: getToolDescription(tool),
    status: (!useTools || useTools.includes(tool.name)) ? 'enable' : 'disable'
  }))
}

// 获取内置工具
export const getBuiltinTools = (): Tool[] => {
  return [
    BashTool as unknown as Tool,
    GlobTool as unknown as Tool,
    GrepTool as unknown as Tool,
    FileReadTool as unknown as Tool,
    FileWriteTool as unknown as Tool,
    FileEditTool as unknown as Tool,
    TodoWriteTool as unknown as Tool,
    SkillTool as unknown as Tool,
    TaskTool as unknown as Tool,
    NotebookEditTool as unknown as Tool,
    AskUserQuestionTool as unknown as Tool,
    ExitPlanModeTool as unknown as Tool,
  ]
}

// 所有可用工具
export const getTools = memoize(
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
    return tools.map(tool => {
      const jsonSchema = zodToJsonSchema(tool.inputSchema as any);
      const requiredFields = extractRequiredFields(tool.inputSchema);

      // 安全地获取 properties
      const properties = (jsonSchema && typeof jsonSchema === 'object' && 'properties' in jsonSchema)
        ? jsonSchema.properties
        : jsonSchema

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
  (tools: Tool[]) => tools.map(tool => tool.name).sort().join(',')
)

// 辅助函数：获取工具描述
export function getToolDescription(tool: Tool): string {
  if (typeof tool.description === 'function') {
    return tool.description()
  }
  return tool.description || ''
}
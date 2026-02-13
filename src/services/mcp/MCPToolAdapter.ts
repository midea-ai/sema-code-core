/**
 * MCP 工具适配器 - 将 MCP 工具转换为 SemaCore Tool 接口
 */

import { z } from 'zod'
import { Tool } from '../../tools/base/Tool'
import { MCPClient } from './MCPClient'
import { MCPToolDefinition, MCPToolResult } from '../../types/mcp'

/**
 * 将 MCP 工具转换为 SemaCore Tool 接口
 */
export function createMCPToolAdapter(
  client: MCPClient,
  serverName: string,
  toolDef: MCPToolDefinition
): Tool {
  // 将 JSON Schema 转换为 Zod Schema
  const inputSchema = jsonSchemaToZod(toolDef.inputSchema)

  const tool: Tool = {
    name: `mcp__${serverName}__${toolDef.name}`,
    description: toolDef.description || `MCP Tool: ${toolDef.name} from ${serverName}`,
    inputSchema,

    isReadOnly: () => false, 

    async *call(input: z.infer<typeof inputSchema>) {

      try {
        const result = await client.callTool(toolDef.name, input)

        yield {
          type: 'result' as const,
          data: result,
          resultForAssistant: formatMCPResult(result)
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)

        throw error
      }
    },

    genResultForAssistant(output: MCPToolResult): string {
      return formatMCPResult(output)
    },

    getDisplayTitle(_input?: z.infer<typeof inputSchema>): string {
      return `MCP: ${serverName}/${toolDef.name}`
    },

    genToolResultMessage(output: MCPToolResult, input?: z.infer<typeof inputSchema>) {
      const isError = output.isError === true
      const inputStr = input
        ? Object.entries(input)
            .map(([k, v]) => {
              const valueStr = typeof v === 'string' ? `"${v}"` : String(v)
              return `${k}: ${valueStr}`
            })
            .join(', ')
        : ''
      return {
        title: inputStr || `MCP: ${toolDef.name}`,
        summary: isError ? '执行失败' : '执行成功',
        content: formatMCPResult(output)
      }
    },

    genToolPermission(input?: z.infer<typeof inputSchema>) {
      const inputStr = input
        ? Object.entries(input)
            .map(([k, v]) => {
              const valueStr = typeof v === 'string' ? `"${v}"` : String(v)
              return `${k}: ${valueStr}`
            })
            .join(', ')
        : ''
      return {
        title: inputStr || `MCP: ${toolDef.name}`,
        content: toolDef.description || `MCP Tool: ${toolDef.name} from ${serverName}`
      }
    }
  }

  return tool
}

/**
 * JSON Schema 转 Zod Schema
 */
function jsonSchemaToZod(schema: MCPToolDefinition['inputSchema']): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {}

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      let zodType: z.ZodTypeAny = createZodType(prop)

      // 添加描述
      if (prop.description) {
        zodType = zodType.describe(prop.description)
      }

      // 处理可选字段
      if (!schema.required?.includes(key)) {
        zodType = zodType.optional()
      }

      shape[key] = zodType
    }
  }

  return z.object(shape)
}

/**
 * 根据 JSON Schema 类型创建对应的 Zod 类型
 */
function createZodType(prop: any): z.ZodTypeAny {
  switch (prop.type) {
    case 'string':
      if (prop.enum) {
        return z.enum(prop.enum as [string, ...string[]])
      }
      return z.string()

    case 'number':
      return z.number()

    case 'integer':
      return z.number().int()

    case 'boolean':
      return z.boolean()

    case 'array':
      if (prop.items) {
        return z.array(createZodType(prop.items))
      }
      return z.array(z.any())

    case 'object':
      if (prop.properties) {
        return jsonSchemaToZod(prop as MCPToolDefinition['inputSchema'])
      }
      return z.record(z.any())

    case 'null':
      return z.null()

    default:
      // 处理联合类型
      if (Array.isArray(prop.type)) {
        const types = prop.type.map((t: string) => createZodType({ type: t }))
        return z.union(types as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
      }
      return z.any()
  }
}

/**
 * 格式化 MCP 结果
 */
function formatMCPResult(result: MCPToolResult): string {
  if (!result.content || result.content.length === 0) {
    return result.isError ? '[Error: No content returned]' : '[No content]'
  }

  return result.content
    .map(item => {
      switch (item.type) {
        case 'text':
          return item.text || ''
        case 'image':
          return `[Image: ${item.mimeType || 'unknown'}]`
        case 'resource':
          return `[Resource: ${item.mimeType || 'unknown'}]`
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 解析 MCP 工具名称，返回服务器名和原始工具名
 */
export function parseMCPToolName(fullName: string): { serverName: string; toolName: string } | null {
  if (!fullName.startsWith('mcp__')) {
    return null
  }

  const parts = fullName.split('__')
  if (parts.length < 3) {
    return null
  }

  return {
    serverName: parts[1],
    toolName: parts.slice(2).join('__')
  }
}

/**
 * 判断是否为 MCP 工具
 */
export function isMCPTool(toolName: string): boolean {
  return toolName.startsWith('mcp__')
}

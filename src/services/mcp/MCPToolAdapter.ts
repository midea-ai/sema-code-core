/**
 * MCP 工具适配器 - 将 MCP 工具转换为 SemaCore Tool 接口
 */

import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { Tool } from '../../tools/base/Tool'
import { MCPClient, MCPProgress } from './MCPClient'
import { MCPToolDefinition, MCPToolResult } from '../../types/mcp'
import { normalizeImage, ImageTooLargeError } from '../../util/imageCompress'
import { logWarn } from '../../util/log'
import { TOOL_INTERRUPT_MSG } from '../../util/message'
import { MAIN_AGENT_ID } from '../../manager/StateManager'
import { getEventBus } from '../../events/EventSystem'
import type { ToolExecutionChunkData } from '../../events/types'
import { getTimeTag } from '../../util/time'

// MCP 调用超过该时长仍未返回、且 server 没报过进度，才自建一条「运行中」chunk；短调用与自报进度的调用不发
const SLOW_CALL_NOTICE_MS = 3000

/** 工具入参的单行展示（chunk / complete / permission 共用，保证同一调用的标题一致） */
function formatInputTitle(input?: Record<string, unknown>): string {
  if (!input) return ''
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : String(v)}`)
    .join(', ')
}

/**
 * 将 MCP 工具转换为 SemaCore Tool 接口
 */
export function createMCPToolAdapter(
  client: MCPClient,
  serverName: string,
  toolDef: MCPToolDefinition
): Tool {
  // 将 JSON Schema 转换为 Zod Schema
  const toolParams = jsonSchemaToZod(toolDef.toolParams)

  const tool: Tool = {
    name: `mcp__${serverName.replace(/:/g, '_')}__${toolDef.name}`,
    description: toolDef.description || `MCP Tool: ${toolDef.name} from ${serverName}`,
    toolParams,

    isSafe: () => false,

    // 仅 server 显式标 destructiveHint=true 且未标只读才算破坏性；未标注按协议默认应视为 true，
    // 但这里刻意按「用户自装即信任」处理为非破坏性，否则 auto 模式下等同于全部转人工
    isDestructive: () => toolDef.annotations?.destructiveHint === true && toolDef.annotations?.readOnlyHint !== true,

    // 中断在 call 内部消化为 interrupted 结果（与 generate_image 一致），宿主收到的是带 interrupted 的 complete 而非 error
    supportsInterrupt: () => true,

    async *call(input: z.infer<typeof toolParams>, agentContext: any) {
      const signal: AbortSignal | undefined = agentContext?.abortController?.signal

      // 运行中提示只发给主代理（子代理的工具行宿主不展示）。两条来源：
      // - server 的 notifications/progress：收到即发 chunk，内容用 server 的 message，没有就用 progress/total
      // - 自建提示：超过 SLOW_CALL_NOTICE_MS 仍无返回也无进度才发一条，当作首条进度；server 已先报过进度就不发
      // 三条终止路径（正常/isError → complete|error、异常或 SDK 超时 → error、中断 → complete+interrupted）
      // 都会收口，宿主不会卡在运行中；调用结束后 finished 置位，迟到的进度不再发 chunk
      const emitChunk = agentContext?.agentId === MAIN_AGENT_ID
        ? (text: string) => {
            const chunkData: ToolExecutionChunkData = {
              agentId: agentContext.agentId,
              toolId: agentContext.currentToolUseID || '',
              toolName: tool.name,
              title: formatInputTitle(input),
              summary: '',
              content: `${getTimeTag()}${text}\n`,
            }
            getEventBus().emit('tool:execution:chunk', chunkData, agentContext.sessionId)
          }
        : undefined
      let finished = false
      let progressSeen = false
      const onprogress = emitChunk
        ? (p: MCPProgress) => {
            if (finished) return
            progressSeen = true
            emitChunk(p.message || (p.total !== undefined ? `${p.progress}/${p.total}` : String(p.progress)))
          }
        : undefined
      const noticeTimer = emitChunk
        ? setTimeout(() => {
            if (!progressSeen) emitChunk(`Calling ${serverName}/${toolDef.name}...`)
          }, SLOW_CALL_NOTICE_MS)
        : undefined

      let result: MCPToolResult
      try {
        result = await normalizeMCPImages(await client.callTool(toolDef.name, input, { signal, onprogress }))
      } catch (error) {
        // 用户中断：信号已传给 SDK，本地立即以 abort 拒绝，按正常结果返回；非中断的失败照常抛出
        if (!signal?.aborted) throw error
        result = { content: [], interrupted: true }
      } finally {
        finished = true
        if (noticeTimer) clearTimeout(noticeTimer)
      }

      yield {
        type: 'result' as const,
        data: result,
        resultForAssistant: result.interrupted ? TOOL_INTERRUPT_MSG : buildMCPResultForAssistant(result),
        isError: result.isError === true,
      }
    },

    genResultForAssistant(output: MCPToolResult): Anthropic.ToolResultBlockParam['content'] {
      return output.interrupted ? TOOL_INTERRUPT_MSG : buildMCPResultForAssistant(output)
    },

    getDisplayTitle(_input?: z.infer<typeof toolParams>): string {
      return `MCP: ${serverName}/${toolDef.name}`
    },

    genToolResultMessage(output: MCPToolResult, input?: z.infer<typeof toolParams>) {
      return {
        title: formatInputTitle(input),
        summary: '',
        content: output.interrupted ? 'Tool use interrupted by user' : formatMCPResultText(output)
      }
    },

    genToolPermission(input?: z.infer<typeof toolParams>) {
      return {
        title: formatInputTitle(input) || `MCP: ${toolDef.name}`,
        content: toolDef.description || `MCP Tool: ${toolDef.name} from ${serverName}`
      }
    }
  }

  return tool
}

/**
 * JSON Schema 转 Zod Schema
 */
function jsonSchemaToZod(schema: MCPToolDefinition['toolParams']): z.ZodObject<any> {
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
        return jsonSchemaToZod(prop as MCPToolDefinition['toolParams'])
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

type ImageMediaType = Anthropic.Base64ImageSource['media_type']
const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
// 单张图片上限，与 ViewFile / SemaEngine.normalizeAttachments 一致
const MAX_IMAGE_BYTES = 2 * 1024 * 1024
// 单次 MCP 结果的图片预算：数量与累计解码字节数，防止多图把请求体撑爆
const MAX_IMAGES_PER_RESULT = 5
const MAX_TOTAL_IMAGE_BYTES_PER_RESULT = 8 * 1024 * 1024

function isSupportedImage(item: MCPToolResult['content'][number]): boolean {
  return item.type === 'image' && !!item.data && IMAGE_MEDIA_TYPES.has(item.mimeType ?? '')
}

type FittedImage =
  | { ok: true; data: string; mimeType: ImageMediaType; bytes: number }
  | { ok: false; reason: string }

/** 单张图片限幅：走 normalizeImage 统一归一化（大 PNG 转 JPEG、长边缩放、超限压缩），超限无法再压或解码失败时给出省略原因 */
async function fitImage(data: string, mediaType: ImageMediaType): Promise<FittedImage> {
  try {
    const normalized = await normalizeImage(Buffer.from(data, 'base64'), mediaType as Parameters<typeof normalizeImage>[1])
    return { ok: true, data: normalized.data, mimeType: normalized.media_type, bytes: normalized.bytes }
  } catch (e) {
    if (e instanceof ImageTooLargeError) {
      logWarn(`MCP 图片超出上限且无法再压: ${e.message}，已忽略`)
      return { ok: false, reason: e.message }
    }
    logWarn(`处理 MCP 图片失败，已忽略: ${e instanceof Error ? e.message : String(e)}`)
    return { ok: false, reason: 'failed to decode' }
  }
}

/**
 * 规范化 MCP 返回的图片：单张超限则压缩，单次结果受数量与累计大小预算约束，
 * 不满足的图片退化为占位文本，避免超大 base64 进入会话历史后导致后续请求持续失败
 */
async function normalizeMCPImages(result: MCPToolResult): Promise<MCPToolResult> {
  const items = result.content ?? []
  if (!items.some(isSupportedImage)) return result

  const content: MCPToolResult['content'] = []
  let imageCount = 0
  let totalBytes = 0
  for (const item of items) {
    if (!isSupportedImage(item)) {
      content.push(item)
      continue
    }
    const mediaType = item.mimeType as ImageMediaType
    const omit = (reason: string) =>
      content.push({ type: 'text', text: `[Image: ${mediaType} omitted: ${reason}]` })

    if (imageCount >= MAX_IMAGES_PER_RESULT) {
      omit(`exceeds ${MAX_IMAGES_PER_RESULT} images per result`)
      continue
    }
    const fitted = await fitImage(item.data!, mediaType)
    if (!fitted.ok) {
      omit(fitted.reason)
      continue
    }
    if (totalBytes + fitted.bytes > MAX_TOTAL_IMAGE_BYTES_PER_RESULT) {
      logWarn(`MCP 图片累计大小超出单次结果预算 ${Math.round(MAX_TOTAL_IMAGE_BYTES_PER_RESULT / 1024)}KB，已忽略`)
      omit(`exceeds ${Math.round(MAX_TOTAL_IMAGE_BYTES_PER_RESULT / 1024 / 1024)}MB total image budget per result`)
      continue
    }
    imageCount++
    totalBytes += fitted.bytes
    content.push({ type: 'image', data: fitted.data, mimeType: fitted.mimeType })
  }
  return { ...result, content }
}

function emptyResultText(result: MCPToolResult): string {
  return result.isError ? '[Error: No content returned]' : '[No content]'
}

/** 单个 content 项的纯文本表示（图片/资源为占位符），供 UI 与无图场景使用 */
function formatMCPItemText(item: MCPToolResult['content'][number]): string {
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
}

/**
 * 格式化 MCP 结果为纯文本（UI 展示用）
 */
function formatMCPResultText(result: MCPToolResult): string {
  const text = (result.content ?? [])
    .map(formatMCPItemText)
    .filter(Boolean)
    .join('\n')

  return text || emptyResultText(result)
}

/**
 * 构造发给模型的 tool_result 内容：
 * 含可识别图片时返回 text/image block 数组，图片以 base64 原样传给模型；否则返回纯文本
 */
function buildMCPResultForAssistant(result: MCPToolResult): Anthropic.ToolResultBlockParam['content'] {
  const items = result.content ?? []
  if (!items.some(isSupportedImage)) return formatMCPResultText(result)

  const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = []
  for (const item of items) {
    if (isSupportedImage(item)) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', data: item.data!, media_type: item.mimeType as ImageMediaType },
      })
      continue
    }
    const text = formatMCPItemText(item)
    if (text) blocks.push({ type: 'text', text })
  }
  return blocks
}

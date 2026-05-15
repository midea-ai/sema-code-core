import { z } from 'zod'
import { Tool } from './base/Tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/fetchUrl'
import {
  injectPromptIntoMarkdown,
  type FetchUrlResult,
  fetchUrlAsMarkdown,
  FETCH_URL_MAX_MARKDOWN_LEN,
} from '../util/fetchUrl'
import { getEventBus } from '../events/EventSystem'
import type { ToolExecutionChunkData } from '../events/types'
import { MAIN_AGENT_ID } from '../manager/StateManager'
import { getTimeTag } from '../util/time'
import { TOOL_NAME_FETCH_URL } from '../prompt/tool'

const TOOL_NAME = TOOL_NAME_FETCH_URL

const toolParams = z.strictObject({
  url: z.string().url().describe('Target URL to retrieve content from'),
  prompt: z.string().describe('Instruction for processing / summarizing the fetched content'),
})

type ToolRes = {
  bytes: number
  code: number
  codeText: string
  result: string
  durationMs: number
  url: string
}

export const FetchUrl = {
  name: TOOL_NAME,
  description() {
    return TOOL_DESCRIPTION
  },
  toolParams,
  isSafe() {
    return false
  },
  async validateInput({ url }) {
    try {
      new URL(url)
    } catch {
      return {
        result: false,
        message: `The URL "${url}" is malformed and could not be parsed.`,
        errorCode: 1,
      }
    }
    return { result: true }
  },
  genToolResultMessage(data: ToolRes) {
    const sizeKB = (data.bytes / 1024).toFixed(1)
    const maxContentLength = 5000
    return {
      title: data.url,
      summary: '',
      content: data.result.slice(0, maxContentLength) + (data.result.length > maxContentLength ? '...' : ''),
    }
  },
  genToolPermission(input: { url: string; prompt: string }) {
    return {
      title: '',
      content: input.url,
    }
  },
  getDisplayTitle(input?: { url?: string }) {
    if (!input?.url) return 'FetchUrl'
    try {
      return new URL(input.url).hostname
    } catch {
      return 'FetchUrl'
    }
  },
  async *call({ url, prompt }: { url: string; prompt: string }, agentContext: any) {
    const start = Date.now()
    const { abortController } = agentContext

    const isMainAgent = agentContext.agentId === MAIN_AGENT_ID
    const emitChunk = isMainAgent ? (content: string) => {
      const chunkData: ToolExecutionChunkData = {
        agentId: agentContext.agentId,
        toolId: agentContext.currentToolUseID || '',
        toolName: TOOL_NAME,
        title: url,
        summary: '',
        content,
      }
      getEventBus().emit('tool:execution:chunk', chunkData)
    } : undefined

    emitChunk?.(`${getTimeTag()}Retrieving content...\n`)
    const response = await fetchUrlAsMarkdown(url, abortController)

    // 跨域重定向：通知 LLM 重新请求
    if ('type' in response && response.type === 'redirect') {
      const statusText =
        response.statusCode === 301 ? 'Moved Permanently'
        : response.statusCode === 308 ? 'Permanent Redirect'
        : response.statusCode === 307 ? 'Temporary Redirect'
        : 'Found'

      const message = `Cross-origin redirect detected.

From: ${response.originalUrl}
To:   ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

Please call ${TOOL_NAME_FETCH_URL} again with the redirected URL:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`

      const output: ToolRes = {
        bytes: Buffer.byteLength(message),
        code: response.statusCode,
        codeText: statusText,
        result: message,
        durationMs: Date.now() - start,
        url,
      }

      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.genResultForAssistant(output),
      }
      return
    }

    const { content, bytes, code, codeText, contentType } = response as FetchUrlResult

    const sizeKB = (bytes / 1024).toFixed(1)
    emitChunk?.(`${getTimeTag()}Retrieved ${sizeKB}KB (HTTP ${code}), processing content...\n`)

    let result: string
    // 对于小型 markdown 内容直接返回，无需 LLM 处理
    if (contentType.includes('text/markdown') && content.length < FETCH_URL_MAX_MARKDOWN_LEN) {
      result = content
    } else {
      result = await injectPromptIntoMarkdown(prompt, content, abortController.signal)
    }

    const output: ToolRes = {
      bytes,
      code,
      codeText,
      result,
      durationMs: Date.now() - start,
      url,
    }

    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.genResultForAssistant(output),
    }
  },
  genResultForAssistant(output: ToolRes) {
    return output.result
  },
} satisfies Tool<typeof toolParams, ToolRes>

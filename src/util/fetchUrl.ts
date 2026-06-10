import { logError } from './log'
import { buildSecondaryModelPrompt } from '../prompt/tools/fetchUrl'
import { queryQuick } from '../services/api/queryLLM'

const MAX_CONTENT_BYTES = 5 * 1024 * 1024 // 5MB
const TIMEOUT_MS = 30_000

export const FETCH_URL_MAX_MARKDOWN_LEN = 50_000

export type FetchUrlResult = {
  content: string
  bytes: number
  code: number
  codeText: string
  contentType: string
}

type RedirectRecord = {
  type: 'redirect'
  originalUrl: string
  redirectUrl: string
  statusCode: number
}

function createTurndown() {
  const mod = require('turndown') as any
  const Ctor = mod.default ?? mod
  return new Ctor() as { turndown(html: string): string }
}

export async function fetchUrlAsMarkdown(
  url: string,
  abortController: AbortController,
): Promise<FetchUrlResult | RedirectRecord> {
  try {
    const parsed = new URL(url)
    if (url.length > 1000 || parsed.username || parsed.password || !parsed.hostname.includes('.')) {
      throw new Error('The provided URL is not valid.')
    }
  } catch (e) {
    throw e instanceof Error && e.message === 'The provided URL is not valid.' ? e : new Error('The provided URL is not valid.')
  }

  // http -> https
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:'
      url = parsed.toString()
    }
  } catch {}

  const originalOrigin = new URL(url).origin
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS)

  let response: globalThis.Response
  try {
    response = await globalThis.fetch(url, {
      signal: abortController.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/markdown, text/html, */*',
        'User-Agent': 'sema-code-core/1.0 fetch_url',
      },
    })
  } finally {
    clearTimeout(timer)
  }

  // 检测跨域重定向
  if (response.redirected && response.url) {
    const finalOrigin = new URL(response.url).origin
    if (finalOrigin !== originalOrigin) {
      return {
        type: 'redirect',
        originalUrl: url,
        redirectUrl: response.url,
        statusCode: 301,
      }
    }
  }

  const rawBuffer = Buffer.from(await response.arrayBuffer())
  if (rawBuffer.length > MAX_CONTENT_BYTES) {
    throw new Error(`Response body too large: ${rawBuffer.length} bytes (limit ${MAX_CONTENT_BYTES})`)
  }

  const contentType = response.headers.get('content-type') ?? ''
  let content = rawBuffer.toString('utf-8')

  if (contentType.includes('text/html')) {
    try {
      content = createTurndown().turndown(content)
    } catch {}
  }

  return {
    bytes: rawBuffer.length,
    code: response.status,
    codeText: response.statusText,
    content,
    contentType,
  }
}

export async function injectPromptIntoMarkdown(
  prompt: string,
  markdownContent: string,
  signal: AbortSignal,
  sessionId?: string,
): Promise<string> {
  const truncated =
    markdownContent.length > FETCH_URL_MAX_MARKDOWN_LEN
      ? markdownContent.slice(0, FETCH_URL_MAX_MARKDOWN_LEN) + '\n\n[Content trimmed — exceeded length limit.]'
      : markdownContent

  const userPrompt = buildSecondaryModelPrompt(truncated, prompt)

  try {
    const { message } = await queryQuick({ userPrompt, signal, sessionId })
    const firstBlock = message.content[0]
    return firstBlock && 'text' in firstBlock ? firstBlock.text : 'The model returned an empty response.'
  } catch (e) {
    if (signal.aborted) throw new Error('AbortError')
    logError(e)
    return 'Content processing by the model failed.'
  }
}

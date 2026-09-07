import { logError } from './log'
import { buildSecondaryModelPrompt } from '../prompt/tools/fetchUrl'
import { queryQuick } from '../services/api/queryLLM'
import { getConfManager } from '../manager/ConfManager'

const MAX_CONTENT_BYTES = 5 * 1024 * 1024 // 5MB
const TIMEOUT_MS = 30_000

const TOOL_USER_AGENT = 'sema-code-core/1.0 fetch_url'

// 浏览器身份的 User-Agent：仅在 coreConfig.fetchUrlBrowserUserAgent 打开时使用。
// 平台段是 Chrome 自己冻结的固定值（Mac 一律报 Intel/10_15_7，Win11 也报 NT 10.0），照抄即可；
// 不探测本机装了什么浏览器，只用 Chrome 一种标识。
const CHROME_MAJOR = 152 // 随发版定期抬高
const platformSegment = ({
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
  linux: 'X11; Linux x86_64',
} as Record<string, string>)[process.platform] ?? 'X11; Linux x86_64'
const BROWSER_USER_AGENT =
  `Mozilla/5.0 (${platformSegment}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`

function resolveUserAgent(): string {
  const coreConfig = getConfManager().getCoreConfig()
  return coreConfig?.fetchUrlBrowserUserAgent ? BROWSER_USER_AGENT : TOOL_USER_AGENT
}

// 喂给 quick 模型前的截断上限
export const FETCH_URL_MAX_MARKDOWN_LEN = 50_000
// 转换后内容短于此值直接原样返回，不经 quick 模型整理。
// 按字符计：纯中文约 1 字 1 token，英文约 4 字符 1 token。8000 覆盖短文、文档页、验证页，长文交 quick 模型按 prompt 提炼。
export const FETCH_URL_DIRECT_RETURN_LEN = 8_000

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
  const td = new Ctor()
  // Drop script/style/noscript/template blocks: turndown keeps their text by default,
  // and on script-heavy pages that pushes the article past the truncation limit.
  td.remove(['script', 'style', 'noscript', 'template'])
  return td as { turndown(html: string): string }
}

// 去掉行尾空白、把连续空行压成一个：微信等页面每段之间都是空行，turndown 输出里空白能占到六分之一，
// 白白占用直接返回阈值和模型上下文。只动行尾不动行首，避免破坏缩进代码块和嵌套列表。
function normalizeMarkdownWhitespace(md: string): string {
  return md.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim()
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
        'User-Agent': resolveUserAgent(),
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
      content = normalizeMarkdownWhitespace(createTurndown().turndown(content))
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

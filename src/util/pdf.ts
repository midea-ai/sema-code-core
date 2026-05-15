import { stat } from 'fs/promises'
import { execFileSafely } from './file'
import { formatSize } from './format'

const PDF_MAX_BYTES = 20 * 1024 * 1024 // 20MB

export const PDF_INLINE_MENTION_LIMIT = 10 // 超过 10 页需要指定页码范围
export const PDF_PAGES_PER_READ_LIMIT = 20 // 每次最多读取 20 页

export type PdfExtractResult = {
  filePath: string
  originalSize: number
  count: number
  text: string
}

type PageOptions = { firstPage?: number; lastPage?: number }

let pdftotextAvailable: boolean | undefined

/**
 * 提取 PDF 页面文本内容。依赖 poppler-utils (pdftotext)。
 */
export async function extractPdfText(
  filePath: string,
  options?: PageOptions,
): Promise<PdfExtractResult> {
  const { size: originalSize } = await stat(filePath)

  if (originalSize === 0) throw new Error(`PDF 文件为空: ${filePath}`)
  if (originalSize > PDF_MAX_BYTES)
    throw new Error(`PDF 文件超过允许的最大大小 (${formatSize(PDF_MAX_BYTES)})。`)

  if (pdftotextAvailable === undefined) {
    const result = await execFileSafely('pdftotext', ['-v'], undefined, 5000)
    pdftotextAvailable = result.code === 0 || result.stderr.length > 0
  }
  if (!pdftotextAvailable) {
    throw new Error(
      'pdftotext 未安装。请安装 poppler-utils (例如 `brew install poppler` 或 `apt-get install poppler-utils`) 以启用 PDF 文本提取。',
    )
  }

  const args = ['-layout']
  if (options?.firstPage) args.push('-f', String(options.firstPage))
  if (options?.lastPage && options.lastPage !== Infinity) args.push('-l', String(options.lastPage))
  args.push(filePath, '-')

  const { code, stdout, stderr } = await execFileSafely('pdftotext', args, undefined, 120_000)
  if (code !== 0) {
    if (/password/i.test(stderr)) throw new Error('PDF 受密码保护。请提供未受保护的版本。')
    if (/damaged|corrupt|invalid/i.test(stderr)) throw new Error('PDF 文件已损坏或无效。')
    throw new Error(`pdftotext 失败: ${stderr}`)
  }

  if (!stdout.trim()) throw new Error('pdftotext 未提取到文本。PDF 可能是纯图片格式。')

  // 通过分页符计算页数
  const pages = stdout.split('\f')
  const count = pages[pages.length - 1]?.trim() === '' ? pages.length - 1 : pages.length

  return { filePath, originalSize, text: stdout, count: Math.max(count, 1) }
}

/**
 * 解析 PDF 页面范围字符串 (例如 "1-5", "3", "10-20")
 */
export function parsePdfPageRange(pages: string): {
  firstPage: number
  lastPage: number
} | null {
  const match = /^(\d+)(?:-(\d+))?$/.exec(pages.trim())
  if (!match) return null

  const first = parseInt(match[1]!, 10)
  const last = match[2] ? parseInt(match[2], 10) : first

  if (first < 1 || last < first) return null
  return { firstPage: first, lastPage: last }
}

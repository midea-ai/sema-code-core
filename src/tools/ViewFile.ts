import { extname } from 'node:path'
import * as fs from 'node:fs'
import { homedir } from 'node:os'
import { z } from 'zod'
import { Tool } from './base/Tool'
import {
  formatWithLineNumbers,
  findFileWithDifferentExt,
  canonicalizeFilePath,
  readTextContent,
  getDisplayPath,
  inferLineEndings,
  execFileSafely,
} from '../util/file'
import { readInitialCwd } from '../util/cwd'
import { TOOL_NAME_VIEW_FILE } from '../prompt/tool'
import { TOOL_DESCRIPTION, VIEW_FILE_MAX_LINES, VIEW_FILE_MAX_LINE_LENGTH } from '../prompt/tools/viewFile'
import { safeGetFileInfo } from '../util/secureFile'
import { getStateManager } from '../manager/StateManager'
import { loadNotebook, formatNotebookCells } from '../util/notebook'
import { NotebookCellData } from '../types/notebook'
import { logDebug, logWarn } from '../util/log'
import { compressImage } from '../util/imageCompress'
import {
  extractPdfText,
  parsePdfPageRange,
  PDF_INLINE_MENTION_LIMIT,
  PDF_PAGES_PER_READ_LIMIT,
} from '../util/pdf'
import { formatFileSizeError } from '../util/format'

const RENDER_MAX_LINES = 5
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024

const LINE_TRUNCATED_SUFFIX = '... [line truncated]'

function truncateLine(line: string, maxLen = VIEW_FILE_MAX_LINE_LENGTH): string {
  return line.length > maxLen ? line.slice(0, maxLen) + LINE_TRUNCATED_SUFFIX : line
}

function truncateLongLines(text: string, maxLen = VIEW_FILE_MAX_LINE_LENGTH): string {
  if (!text) return text
  if (text.length <= maxLen) return text
  let needsTruncation = false
  const lines = text.split('\n')
  for (const line of lines) {
    if (line.length > maxLen) {
      needsTruncation = true
      break
    }
  }
  if (!needsTruncation) return text
  return lines.map(line => truncateLine(line, maxLen)).join('\n')
}
export const DOC_NOT_SUPPORTED_MESSAGE = `DOC/DOCX files cannot be read directly. Use the run_shell tool to extract text instead:

.docx (recommended):
  python -c "import zipfile,xml.etree.ElementTree as ET; root=ET.parse(zipfile.ZipFile('your_file.docx').open('word/document.xml')).getroot(); ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main'; [print(''.join(t.text for t in p.iter(f'{{{ns}}}t') if t.text)) for p in root.iter(f'{{{ns}}}p')]"

.doc on Windows (requires pywin32: pip install pywin32):
  python -c "import win32com.client; w=win32com.client.Dispatch('Word.Application'); w.Visible=False; d=w.Documents.Open(r'C:\\\\full\\\\path\\\\to\\\\your_file.doc'); print(d.Content.Text); d.Close(); w.Quit()"

.doc on Linux/Mac (requires LibreOffice):
  soffice --headless --convert-to txt your_file.doc`

const SPREADSHEET_NOT_SUPPORTED_EXTS = new Set(['.xls', '.xlsx', '.xlsm', '.xlsb', '.ods'])

export const SPREADSHEET_NOT_SUPPORTED_MESSAGE =
  'Spreadsheet files (.xls, .xlsx, .xlsm, .xlsb, .ods) are not supported and cannot be read directly — their binary content would appear as garbled text.'


const SUPPORTED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const IMAGE_MEDIA_TYPES: Record<string, 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const toolParams = z.strictObject({
  file_path: z.string({
    required_error: 'Missing required parameter \'file_path\'. Please provide the absolute path to the file, e.g. {"file_path": "/path/to/file.txt"}.',
  }).describe('Absolute path of the file to read'),
  start_line: z
    .number()
    .optional()
    .describe(
      'Starting line number (1-indexed) for partial reads. Use with max_lines to paginate large files.',
    ),
  max_lines: z
    .number()
    .optional()
    .describe(
      'Maximum number of lines to return. Use with start_line to paginate large files.',
    ),
  pdf_page_range: z
    .string()
    .optional()
    .describe(
      'PDF-only: page range to extract (e.g., "1-5", "3", "10-20"). Up to 20 pages per call.',
    ),
})

export const ViewFile = {
  name: TOOL_NAME_VIEW_FILE,
  description() {
    return TOOL_DESCRIPTION
  },
  toolParams,
  isSafe() {
    return false
  },
  canRunConcurrently() {
    return true
  },
  genToolPermission(input) {
    return {
      title: getDisplayPath(input.file_path),
      content: '',
    }
  },
  genToolResultMessage(data) {
    if (data.type === 'image') {
      const displayPath = getDisplayPath(data.image.filePath)
      return {
        title: displayPath,
        summary: `Read image ${displayPath}`,
        content: '',
      }
    }

    if (data.type === 'notebook') {
      const { filePath, cellCount } = data.notebook
      const cellText = cellCount === 1 ? 'cell' : 'cells'
      const displayPath = getDisplayPath(filePath)
      return {
        title: displayPath,
        summary: `Read ${displayPath} with ${cellCount} ${cellText}`,
        content: ''
      }
    }

    if (data.type === 'pdf_parts') {
      const displayPath = getDisplayPath(data.pdfParts.filePath)
      const contentPreview = data.pdfParts.text
        ? data.pdfParts.text.split('\n').slice(0, 3).join('\n')
        : ''
      return {
        title: displayPath,
        summary: `Read ${data.pdfParts.count} pages from PDF ${displayPath}`,
        content: contentPreview ? contentPreview + '\n...' : '',
      }
    }

    const { filePath, content, numLines, startLine, totalLines } = data.file
    const contentWithFallback = content || '(No content)'
    const lines = contentWithFallback.split('\n')
    const previewLines = lines.slice(0, RENDER_MAX_LINES).map(truncateLine)
    let preview = previewLines.join('\n')

    if (numLines > RENDER_MAX_LINES) {
      preview += `\n... (+${numLines - RENDER_MAX_LINES} more lines)`
    }

    const lineText = numLines === 1 ? 'line' : 'lines'
    const displayPath = getDisplayPath(filePath)
    const isPartialRead = startLine > 1 || numLines < totalLines
    const endLine = startLine + numLines - 1
    const title = isPartialRead ? `${displayPath}:${startLine}-${endLine}` : displayPath

    return {
      title,
      summary: `Read ${displayPath} with ${numLines} ${lineText}`,
      content: preview
    }
  },
  async validateInput({ file_path, start_line, max_lines, pdf_page_range }, agentContext: any) {
    if (pdf_page_range !== undefined) {
      const parsed = parsePdfPageRange(pdf_page_range)
      if (!parsed) {
        return {
          result: false,
          message: `Unrecognized pdf_page_range format: "${pdf_page_range}". Expected formats: "1-5", "3", or "10-20" (1-indexed).`,
        }
      }
      const rangeSize =
        parsed.lastPage === Infinity
          ? PDF_PAGES_PER_READ_LIMIT + 1
          : parsed.lastPage - parsed.firstPage + 1
      if (rangeSize > PDF_PAGES_PER_READ_LIMIT) {
        return {
          result: false,
          message: `Page range "${pdf_page_range}" exceeds the ${PDF_PAGES_PER_READ_LIMIT}-page limit per request. Please narrow the range.`,
        }
      }
    }

    const fullFilePath = canonicalizeFilePath(file_path)
    const fileCheck = safeGetFileInfo(fullFilePath)
    if (!fileCheck.success) {
      let message = fileCheck.error || 'Unable to access the file.'

      if (message.includes('outside allowed directories')) {
        const allowedPaths = [
          `Current working directory: ${readInitialCwd()}`,
          `User home directory: ${homedir()}`,
          `Temporary directories: /tmp, /var/tmp`,
        ]
        logWarn('ViewFileTool: File access denied')
        logDebug(`Requested path: ${fullFilePath}`)
        logDebug('Currently allowed base paths:')
        allowedPaths.forEach(p => logDebug(`  - ${p}`))
        message += '\n\nCurrently allowed base paths:\n' + allowedPaths.map(p => `  - ${p}`).join('\n')
      } else {
        const similarFilename = findFileWithDifferentExt(fullFilePath)
        if (similarFilename) {
          message += ` Perhaps you meant ${similarFilename}?`
        }
      }

      return { result: false, message }
    }

    const stats = fileCheck.stats!
    const fileSize = stats.size

    const lowerExtForDoc = extname(fullFilePath).toLowerCase()
    if (lowerExtForDoc === '.doc' || lowerExtForDoc === '.docx') {
      return { result: false, message: DOC_NOT_SUPPORTED_MESSAGE }
    }

    if (SPREADSHEET_NOT_SUPPORTED_EXTS.has(lowerExtForDoc)) {
      return { result: false, message: SPREADSHEET_NOT_SUPPORTED_MESSAGE }
    }

    const isImageFile = SUPPORTED_IMAGE_EXTS.has(extname(fullFilePath).toLowerCase())
    const isPDFFile = extname(fullFilePath).toLowerCase() === '.pdf'
    if (!isImageFile && !isPDFFile && fileSize > MAX_OUTPUT_BYTES && !start_line && !max_lines) {
      return {
        result: false,
        message: formatFileSizeError(fileSize, MAX_OUTPUT_BYTES),
        meta: { fileSize },
      }
    }

    return { result: true }
  },
  async *call(
    { file_path, start_line = 1, max_lines = VIEW_FILE_MAX_LINES, pdf_page_range },
    agentContext: any,
  ) {
    const fullFilePath = canonicalizeFilePath(file_path)
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)

    agentState.setReadFileTimestamp(fullFilePath, Date.now())

    // 对非特殊格式文件，缓存换行符类型供后续 Edit/Write 使用
    const fileExtension = extname(fullFilePath)
    const lowerExtForLineEnding = fileExtension.toLowerCase()
    if (!SUPPORTED_IMAGE_EXTS.has(lowerExtForLineEnding) && fileExtension.toLowerCase() !== '.pdf' && lowerExtForLineEnding !== '.ipynb') {
      agentState.setFileLineEnding(fullFilePath, inferLineEndings(fullFilePath))
    }

    if (fileExtension.toLowerCase() === '.doc' || fileExtension.toLowerCase() === '.docx') {
      throw new Error(DOC_NOT_SUPPORTED_MESSAGE)
    }

    if (SPREADSHEET_NOT_SUPPORTED_EXTS.has(fileExtension.toLowerCase())) {
      throw new Error(SPREADSHEET_NOT_SUPPORTED_MESSAGE)
    }

    if (fileExtension.toLowerCase() === '.pdf') {
      const parsedRange = pdf_page_range ? parsePdfPageRange(pdf_page_range) : undefined

      if (!parsedRange) {
        const { code, stdout } = await execFileSafely('pdfinfo', [fullFilePath], undefined, 10_000)
        const pagesMatch = code === 0 ? /^Pages:\s+(\d+)/m.exec(stdout) : null
        const pageCount = pagesMatch ? parseInt(pagesMatch[1]!, 10) : NaN
        if (!isNaN(pageCount) && pageCount > PDF_INLINE_MENTION_LIMIT) {
          throw new Error(
            `This PDF contains ${pageCount} pages — too large to read in one call. ` +
              `Specify a page range via the pages parameter (e.g., pages: "1-5"), ` +
              `up to ${PDF_PAGES_PER_READ_LIMIT} pages per request.`,
          )
        }
      }

      const { originalSize, count, text } = await extractPdfText(fullFilePath, parsedRange ?? undefined)

      const data = {
        type: 'pdf_parts' as const,
        pdfParts: { filePath: file_path, originalSize, count, text },
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    const lowerExt = fileExtension.toLowerCase()
    if (SUPPORTED_IMAGE_EXTS.has(lowerExt)) {
      const imageBuffer = fs.readFileSync(fullFilePath)
      const mediaType = IMAGE_MEDIA_TYPES[lowerExt]

      let imageData: string
      let finalMediaType: typeof mediaType

      if (imageBuffer.length > MAX_OUTPUT_BYTES) {
        if (mediaType === 'image/gif') {
          throw new Error(formatFileSizeError(imageBuffer.length, MAX_OUTPUT_BYTES))
        }
        logWarn(`ViewFileTool: image size ${Math.round(imageBuffer.length / 1024)}KB exceeds limit ${Math.round(MAX_OUTPUT_BYTES / 1024)}KB, compressing...`)
        let compressed: Awaited<ReturnType<typeof compressImage>>
        try {
          compressed = await compressImage(imageBuffer, mediaType, MAX_OUTPUT_BYTES)
        } catch (e: any) {
          throw new Error(formatFileSizeError(imageBuffer.length, MAX_OUTPUT_BYTES))
        }
        const compressedBytes = Math.ceil(compressed.data.length * 3 / 4)
        if (compressedBytes > MAX_OUTPUT_BYTES) {
          throw new Error(formatFileSizeError(compressedBytes, MAX_OUTPUT_BYTES))
        }
        imageData = compressed.data
        finalMediaType = compressed.media_type
      } else {
        imageData = imageBuffer.toString('base64')
        finalMediaType = mediaType
      }

      const data = {
        type: 'image' as const,
        image: { filePath: file_path, data: imageData, media_type: finalMediaType },
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    if (fileExtension === '.ipynb') {
      const { cells, cellCount } = loadNotebook(fullFilePath)

      const data = {
        type: 'notebook' as const,
        notebook: { filePath: file_path, cells, cellCount },
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    const lineOffset = start_line === 0 ? 0 : start_line - 1
    const { content, lineCount, totalLines } = readTextContent(fullFilePath, lineOffset, max_lines)

    if (content.length > MAX_OUTPUT_BYTES) {
      throw new Error(formatFileSizeError(content.length, MAX_OUTPUT_BYTES))
    }

    const data = {
      type: 'text' as const,
      file: {
        filePath: file_path,
        content,
        numLines: lineCount,
        startLine: start_line,
        totalLines,
      },
    }

    yield {
      type: 'result',
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant(data) {
    if (data.type === 'image') {
      return [
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            data: data.image.data,
            media_type: data.image.media_type,
          },
        },
      ]
    }

    if (data.type === 'notebook') {
      return formatNotebookCells(data.notebook.cells)
    }

    if (data.type === 'pdf_parts') {
      return data.pdfParts.text
    }

    return formatWithLineNumbers({
      content: truncateLongLines(data.file.content),
      startLine: data.file.startLine,
    })
  },
} satisfies Tool<
  typeof toolParams,
  | {
      type: 'text'
      file: {
        filePath: string
        content: string
        numLines: number
        startLine: number
        totalLines: number
      }
    }
  | {
      type: 'notebook'
      notebook: {
        filePath: string
        cells: NotebookCellData[]
        cellCount: number
      }
    }
  | {
      type: 'image'
      image: {
        filePath: string
        data: string
        media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      }
    }
  | {
      type: 'pdf_parts'
      pdfParts: {
        filePath: string
        originalSize: number
        count: number
        text: string
      }
    }
>

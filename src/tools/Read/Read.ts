import { relative, extname } from 'node:path'
import { z } from 'zod'
import { Tool } from '../base/Tool'
import {
  addLineNumbers,
  findSimilarFile,
  normalizeFilePath,
  readTextContent,
} from '../../util/file'
import { getCwd } from '../../util/cwd'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { secureFileService } from '../../util/secureFile'
import { getStateManager } from '../../manager/StateManager'
import { readNotebook, formatNotebookCells } from '../../util/notebook'
import { NotebookCellData } from '../../types/notebook'

const MAX_LINES_TO_RENDER = 5
const MAX_OUTPUT_SIZE = 0.25 * 1024 * 1024 // 0.25MB in bytes

const inputSchema = z.strictObject({
  file_path: z.string({
    required_error: 'Error: The Read tool requires a \'file_path\' parameter to specify which file to read. Please provide the absolute path to the file you want to view. For example: {"file_path": "/path/to/file.txt"}',
  }).describe('The absolute path to the file to read'),
  offset: z
    .number()
    .optional()
    .describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
  limit: z
    .number()
    .optional()
    .describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
})

export const FileReadTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  genToolResultMessage(data) {
    // 处理 notebook 文件
    if (data.type === 'notebook') {
      const { filePath, cellCount } = data.notebook
      const cellText = cellCount === 1 ? 'cell' : 'cells'
      return {
        title: relative(getCwd(), filePath),
        summary: `Read ${relative(getCwd(), filePath)} with ${cellCount} ${cellText}`,
        content: ''
      }
    }

    // 处理普通文本文件
    const { filePath, content, numLines, startLine, totalLines } = data.file
    const contentWithFallback = content || '(No content)'
    const lines = contentWithFallback.split('\n')
    const previewLines = lines.slice(0, MAX_LINES_TO_RENDER)
    let preview = previewLines.join('\n')

    if (numLines > MAX_LINES_TO_RENDER) {
      preview += `\n... (+${numLines - MAX_LINES_TO_RENDER} more lines)`
    }

    const lineText = numLines === 1 ? 'line' : 'lines'
    const relativePath = relative(getCwd(), filePath)

    // 部分读取时，标题显示行号范围
    const isPartialRead = startLine > 1 || numLines < totalLines
    const endLine = startLine + numLines - 1
    const title = isPartialRead
      ? `${relativePath}:${startLine}-${endLine}`
      : relativePath

    return {
      title,
      summary: `Read ${relativePath} with ${numLines} ${lineText}`,
      content: preview
    }
  },
  async validateInput({ file_path, offset, limit }, agentContext: any) {
    const fullFilePath = normalizeFilePath(file_path)

    // Use secure file service to check if file exists and get file info
    const fileCheck = secureFileService.safeGetFileInfo(fullFilePath)
    if (!fileCheck.success) {
      // Use the actual error from secureFileService instead of generic message
      let message = fileCheck.error || 'File access failed.'

      // If it's a path restriction error, provide helpful information
      if (message.includes('outside allowed directories')) {
        // Get current allowed paths for debuggingS
        const allowedPaths = [
          `Current working directory: ${getCwd()}`,
          `User home directory: ${require('os').homedir()}`,
          `Temporary directories: /tmp, /var/tmp`
        ]

        console.log('🚫 ReadTool: File access denied')
        console.log(`📁 Requested path: ${fullFilePath}`)
        console.log('📋 Currently allowed base paths:')
        allowedPaths.forEach(path => console.log(`  - ${path}`))

        message += '\n\nCurrently allowed base paths:\n' + allowedPaths.map(p => `  - ${p}`).join('\n')
      } else {
        // For other errors (like actual file not found), try to find similar files
        const similarFilename = findSimilarFile(fullFilePath)
        if (similarFilename) {
          message += ` Did you mean ${similarFilename}?`
        }
      }

      return {
        result: false,
        message,
      }
    }

    const stats = fileCheck.stats!
    const fileSize = stats.size

    // If file is too large and no offset/limit provided
    if (fileSize > MAX_OUTPUT_SIZE && !offset && !limit) {
      return {
        result: false,
        message: formatFileSizeError(fileSize),
        meta: { fileSize },
      }
    }

    return { result: true }
  },
  async *call(
    { file_path, offset = 1, limit = undefined },
    agentContext: any,
  ) {
    const fullFilePath = normalizeFilePath(file_path)
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)

    // Update read timestamp, to invalidate stale writes
    agentState.setReadFileTimestamp(fullFilePath, Date.now())

    // 检测是否为 notebook 文件
    const fileExtension = extname(fullFilePath)

    if (fileExtension === '.ipynb') {
      // 读取并解析 notebook 文件
      const { cells, cellCount } = readNotebook(fullFilePath)

      const data = {
        type: 'notebook' as const,
        notebook: {
          filePath: file_path,
          cells,
          cellCount,
        },
      }

      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    // 处理普通文本文件
    // Handle offset properly - if offset is 0, don't subtract 1
    const lineOffset = offset === 0 ? 0 : offset - 1
    const { content, lineCount, totalLines } = readTextContent(
      fullFilePath,
      lineOffset,
      limit,
    )

    // Add size validation after reading
    if (content.length > MAX_OUTPUT_SIZE) {
      throw new Error(formatFileSizeError(content.length))
    }

    const data = {
      type: 'text' as const,
      file: {
        filePath: file_path,
        content: content,
        numLines: lineCount,
        startLine: offset,
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
    // 处理 notebook 文件
    if (data.type === 'notebook') {
      return formatNotebookCells(data.notebook.cells)
    }

    // 处理普通文本文件
    return addLineNumbers(data.file)
  },
} satisfies Tool<
  typeof inputSchema,
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
>

const formatFileSizeError = (sizeInBytes: number) =>
  `File content (${Math.round(sizeInBytes / 1024)}KB) exceeds maximum allowed size (${Math.round(MAX_OUTPUT_SIZE / 1024)}KB). Please use offset and limit parameters to read specific portions of the file, or use the GrepTool to search for specific content.`

import { Hunk } from 'diff'
import { existsSync, mkdirSync, statSync } from 'fs'
import { dirname, relative } from 'path'
import { z } from 'zod'
import type { Tool } from './base/Tool'
import {
  formatWithLineNumbers,
  inferFileEncoding,
  inferLineEndings,
  writeTextFile,
  canonicalizeFilePath,
  readTextContent,
  LineEndingKind,
} from '../util/file'
import { readInitialCwd } from '../util/cwd'
import { IS_WIN } from '../util/platform'
import { TOOL_NAME_WRITE_FILE, TOOL_NAME_VIEW_FILE, TOOL_NAME_PATCH_FILE } from '../prompt/tool'
import { getStateManager } from '../manager/StateManager'
import { getPatch } from '../util/diff'
import {
  getWriteFileTitle,
  normalizeToLF,
  truncateContentForAssistant,
  buildPermissionPreview,
  buildResultPreview,
} from '../util/writeFile'

const toolParams = z.strictObject({
  file_path: z
    .string()
    .describe(
      'Absolute destination path for the file (relative paths are not accepted)',
    ),
  file_content: z.string().describe('Full text content to write into the file'),
})

export const WriteFile = {
  name: TOOL_NAME_WRITE_FILE,
  description() {
    return `Create a new file or fully rewrite an existing file.

Usage pattern: ${TOOL_NAME_VIEW_FILE} → ${TOOL_NAME_PATCH_FILE} for partial edits; ${TOOL_NAME_WRITE_FILE} only for new files or complete rewrites.

Rules:
- For existing files: MUST use ${TOOL_NAME_VIEW_FILE} first (will error otherwise). Prefer ${TOOL_NAME_PATCH_FILE} for partial changes — only use ${TOOL_NAME_WRITE_FILE} when rewriting the entire file.
- Never create new files (especially *.md/README) unless the user explicitly asks.
- No emojis in file_content unless requested.`
  },
  toolParams,
  isSafe() {
    return false
  },
  genToolPermission(input) {
    const title = getWriteFileTitle(input)
    const fullFilePath = canonicalizeFilePath(input.file_path)
    const fileExists = existsSync(fullFilePath)
    const oldContent = fileExists ? readTextContent(fullFilePath).content : ''
    const normalizedContent = normalizeToLF(input.file_content)
    const contentPreview = buildPermissionPreview(fullFilePath, oldContent, normalizedContent, fileExists)
    return { title, content: contentPreview }
  },
  genToolResultMessage({ filePath, content, structuredPatch, type }) {
    const title = getWriteFileTitle({ file_path: filePath })
    const displayPath = relative(readInitialCwd(), filePath)
    const { summary, contentPreview } = buildResultPreview(type, filePath, content, structuredPatch)
    const finalSummary = type === 'create' ? `Created ${displayPath} ${summary}` : summary
    return { title, summary: finalSummary, content: contentPreview }
  },
  getDisplayTitle(input) {
    return getWriteFileTitle(input)
  },
  async validateInput({ file_path }, agentContext: any) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)
    const fullFilePath = canonicalizeFilePath(file_path)

    if (!existsSync(fullFilePath)) {
      return { result: true }
    }

    const readTimestamp = agentState.getReadFileTimestamp(fullFilePath)
    if (!readTimestamp) {
      return {
        result: false,
        message: 'You need to read the file before overwriting it.',
      }
    }

    const stats = statSync(fullFilePath)
    if (stats.mtimeMs > readTimestamp) {
      return {
        result: false,
        message:
          'The file was modified externally (by the user or a linter) since last read. Please re-read it before writing.',
      }
    }

    return { result: true }
  },
  async *call({ file_path, file_content }, agentContext: any) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)
    const fullFilePath = canonicalizeFilePath(file_path)
    const dir = dirname(fullFilePath)
    const oldFileExists = existsSync(fullFilePath)

    let oldContent: string | null = null
    let enc: BufferEncoding = 'utf-8'
    let endings: LineEndingKind = 'LF'

    if (oldFileExists) {
      oldContent = readTextContent(fullFilePath).content
      enc = inferFileEncoding(fullFilePath)
      endings = agentState.getFileLineEnding(fullFilePath) ?? inferLineEndings(fullFilePath)
    } else {
      endings = IS_WIN ? 'CRLF' : 'LF'
    }

    const normalizedContent = normalizeToLF(file_content)

    mkdirSync(dir, { recursive: true })

    // 权限确认后二次校验时间戳，防止用户在权限对话框期间修改文件
    if (oldFileExists) {
      const readTimestamp = agentState.getReadFileTimestamp(fullFilePath)
      const currentMtime = statSync(fullFilePath).mtimeMs
      if (readTimestamp && currentMtime > readTimestamp) {
        throw new Error('The file changed while awaiting permission. Please re-read it before writing.')
      }
    }

    writeTextFile(fullFilePath, normalizedContent, enc, endings!)
    agentState.setReadFileTimestamp(fullFilePath, statSync(fullFilePath).mtimeMs)

    if (oldContent) {
      const patch = getPatch({
        filePath: fullFilePath,
        fileContents: oldContent,
        oldStr: oldContent,
        newStr: normalizedContent,
      })
      const data = {
        type: 'update' as const,
        filePath: file_path,
        content: normalizedContent,
        structuredPatch: patch,
      }
      yield {
        type: 'result',
        data,
        resultForAssistant: this.genResultForAssistant(data),
      }
      return
    }

    const data = {
      type: 'create' as const,
      filePath: file_path,
      content: normalizedContent,
      structuredPatch: [],
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant({ filePath, content, type }) {
    if (type === 'create') {
      return `New file created: ${filePath}`
    }
    return `Successfully updated ${filePath}. Below is the file content with line numbers:
${formatWithLineNumbers({
      content: truncateContentForAssistant(content),
      startLine: 1,
    })}`
  },
} satisfies Tool<
  typeof toolParams,
  {
    type: 'create' | 'update'
    filePath: string
    content: string
    structuredPatch: Hunk[]
  }
>

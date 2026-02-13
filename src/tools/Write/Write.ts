import { Hunk } from 'diff'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { EOL } from 'os'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { z } from 'zod'
import type { Tool } from '../base/Tool'
import {
  addLineNumbers,
  detectFileEncoding,
  detectLineEndings,
  detectRepoLineEndings,
  writeTextContent,
  normalizeFilePath,
} from '../../util/file'
import { getCwd } from '../../util/cwd'
import { TOOL_NAME_FOR_PROMPT, DESCRIPTION } from './prompt'
import { getStateManager } from '../../manager/StateManager'

import { getPatch, getUpdateSummary, getDiffContent } from '../../util/diff'


const MAX_LINES_TO_RENDER = 5
const MAX_LINES_TO_RENDER_FOR_ASSISTANT = 16000
const TRUNCATED_MESSAGE =
  '<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with Grep in order to find the line numbers of what you are looking for.</NOTE>'

// 辅助函数：生成显示标题
function getTitle(input?: { file_path?: string }) {
  if (input?.file_path) {
    const relativePath = relative(getCwd(), input.file_path)
    return `${relativePath}`
  }
  return TOOL_NAME_FOR_PROMPT
}

const inputSchema = z.strictObject({
  file_path: z
    .string()
    .describe(
      'The absolute path to the file to write (must be absolute, not relative)',
    ),
  content: z.string().describe('The content to write to the file'),
})

export const FileWriteTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  genToolPermission(input) {
    let title = getTitle(input)
    const fullFilePath = normalizeFilePath(input.file_path)
    const fileExists = existsSync(fullFilePath)
    let contentPreview: string | Record<string, any> = ''

    const oldContent = fileExists ? readFileSync(fullFilePath, detectFileEncoding(fullFilePath)) : ''
    const patch = getPatch({
      filePath: fullFilePath,
      fileContents: oldContent,
      oldStr: oldContent,
      newStr: input.content,
    })
    contentPreview = {
      type: fileExists ? 'diff' : 'new',
      patch: patch,
      diffText: ''
    };

    return { title, content: contentPreview }
  },
  genToolResultMessage({ filePath, content, structuredPatch, type }) {
    const title = getTitle({ file_path: filePath })
    const displayPath = relative(getCwd(), filePath)

    let summary;
    let contentPreview: string | Record<string, any> = '';

    switch (type) {
      case 'create': {
        const allLines = content.split(/\r?\n/)
        const numLines = allLines.length
        summary = `Created ${displayPath} with ${numLines} lines`

        const previewLines = allLines.slice(0, MAX_LINES_TO_RENDER).map(l => `+${l}`)
        const diffText = numLines > MAX_LINES_TO_RENDER ? `... (+${numLines - MAX_LINES_TO_RENDER} lines)` : ''

        contentPreview = {
          type: 'new',
          patch: [
            {
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: numLines,
              lines: previewLines,
            }
          ],
          diffText,
        }
        break;
      }
      case 'update': {
        summary = getUpdateSummary(filePath, structuredPatch)
        contentPreview = {
          type: 'diff',
          patch: structuredPatch,
          diffText: ''
        }
        break;
      }
    }

    return { title, summary, content: contentPreview }
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  async validateInput({ file_path }, agentContext: any) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)

    const fullFilePath = normalizeFilePath(file_path)
    if (!existsSync(fullFilePath)) {
      return { result: true }
    }

    const readTimestamp = agentState.getReadFileTimestamp(fullFilePath)
    if (!readTimestamp) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
      }
    }

    // Check if file exists and get its last modified time
    const stats = statSync(fullFilePath)
    const lastWriteTime = stats.mtimeMs
    if (lastWriteTime > readTimestamp) {
      return {
        result: false,
        message:
          'File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.',
      }
    }

    return { result: true }
  },
  async *call({ file_path, content }, agentContext: any) {
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)
    const fullFilePath = normalizeFilePath(file_path)
    const dir = dirname(fullFilePath)
    const oldFileExists = existsSync(fullFilePath)
    const enc = oldFileExists ? detectFileEncoding(fullFilePath) : 'utf-8'
    const oldContent = oldFileExists ? readFileSync(fullFilePath, enc) : null

    const endings = oldFileExists
      ? detectLineEndings(fullFilePath)
      : await detectRepoLineEndings(getCwd())

    mkdirSync(dir, { recursive: true })
    writeTextContent(fullFilePath, content, enc, endings!)

    // Update read timestamp, to invalidate stale writes
    agentState.setReadFileTimestamp(fullFilePath, statSync(fullFilePath).mtimeMs)

    if (oldContent) {
      const patch = getPatch({
        filePath: fullFilePath,
        fileContents: oldContent,
        oldStr: oldContent,
        newStr: content,
      })

      const data = {
        type: 'update' as const,
        filePath: file_path,
        content,
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
      content,
      structuredPatch: [],
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant({ filePath, content, type }) {
    switch (type) {
      case 'create':
        return `File created successfully at: ${filePath}`
      case 'update':
        return `The file ${filePath} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:
${addLineNumbers({
          content:
            content.split(/\r?\n/).length > MAX_LINES_TO_RENDER_FOR_ASSISTANT
              ? content
                .split(/\r?\n/)
                .slice(0, MAX_LINES_TO_RENDER_FOR_ASSISTANT)
                .join('\n') + TRUNCATED_MESSAGE
              : content,
          startLine: 1,
        })}`
    }
  },
} satisfies Tool<
  typeof inputSchema,
  {
    type: 'create' | 'update'
    filePath: string
    content: string
    structuredPatch: Hunk[]
  }
>

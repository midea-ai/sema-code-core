import type { Hunk } from 'diff'
import { relative } from 'path'
import { readInitialCwd } from './cwd'
import { TOOL_NAME_WRITE_FILE, TOOL_NAME_SEARCH_CONTENT } from '../prompt/tool'
import { getPatch, getUpdateSummary } from './diff'

const WRITE_RENDER_MAX_LINES = 5
const WRITE_RENDER_MAX_LINES_FOR_ASSISTANT = 12000
const WRITE_TRUNCATED_MESSAGE =
  `<clipped>Only a portion of the file is shown here. Use ${TOOL_NAME_SEARCH_CONTENT} to locate specific content and line numbers before retrying.`

export function getWriteFileTitle(input?: { file_path?: string }): string {
  if (input?.file_path) {
    return relative(readInitialCwd(), input.file_path)
  }
  return TOOL_NAME_WRITE_FILE
}

export function normalizeToLF(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function truncateContentForAssistant(content: string): string {
  const lines = content.split(/\r?\n/)
  if (lines.length > WRITE_RENDER_MAX_LINES_FOR_ASSISTANT) {
    return (
      lines.slice(0, WRITE_RENDER_MAX_LINES_FOR_ASSISTANT).join('\n') +
      WRITE_TRUNCATED_MESSAGE
    )
  }
  return content
}

export function buildPermissionPreview(
  filePath: string,
  oldContent: string,
  newContent: string,
  fileExists: boolean,
): Record<string, any> {
  const patch = getPatch({
    filePath,
    fileContents: oldContent,
    oldStr: oldContent,
    newStr: newContent,
  })
  return {
    type: fileExists ? 'diff' : 'new',
    patch,
    diffText: '',
  }
}

export function buildResultPreview(
  type: 'create' | 'update',
  filePath: string,
  content: string,
  structuredPatch: Hunk[],
): { summary: string; contentPreview: Record<string, any> } {
  if (type === 'create') {
    const allLines = content.split(/\r?\n/)
    const numLines = allLines.length
    const previewLines = allLines.slice(0, WRITE_RENDER_MAX_LINES).map(l => `+${l}`)
    const diffText =
      numLines > WRITE_RENDER_MAX_LINES ? `... (+${numLines - WRITE_RENDER_MAX_LINES} lines)` : ''
    return {
      summary: `Created with ${numLines} lines`,
      contentPreview: {
        type: 'new',
        patch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: numLines, lines: previewLines }],
        diffText,
      },
    }
  }

  return {
    summary: getUpdateSummary(filePath, structuredPatch),
    contentPreview: {
      type: 'diff',
      patch: structuredPatch,
      diffText: '',
    },
  }
}

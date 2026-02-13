import { Hunk } from 'diff'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'path'
import { z } from 'zod'
import { Tool, ValidationResult } from '../base/Tool'
import {
  detectFileEncoding,
  detectLineEndings,
  findSimilarFile,
  writeTextContent,
  addLineNumbers,
  normalizeFilePath
} from '../../util/file'
import { getPatch, getUpdateSummary, getDiffContent } from '../../util/diff'
import { getCwd } from '../../util/cwd'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'
import { applyEdit } from './utils'
import { TOOL_NAME_FOR_PROMPT as NOTEBOOKEDIT_TOOL_NAME } from '../NotebookEdit/prompt'
import { getStateManager } from '../../manager/StateManager'


const inputSchema = z.strictObject({
  file_path: z.string().describe('The absolute path to the file to modify'),
  old_string: z.string().describe('The text to replace'),
  new_string: z.string().describe('The text to replace it with (must be different from old_string)'),
  replace_all: z.boolean().optional().default(false).describe('Replace all occurences of old_string (default false)')
})

export type In = typeof inputSchema

// Number of lines of context to include before/after the change in our result message
const N_LINES_SNIPPET = 4

// 辅助函数：生成显示标题
function getTitle(input?: { file_path?: string }) {
  if (input?.file_path) {
    const relativePath = relative(getCwd(), input.file_path)
    return `${relativePath}`
  }
  return TOOL_NAME_FOR_PROMPT
}

export const FileEditTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,

  isReadOnly() {
    return false
  },
  genToolPermission(input) {
    const title = getTitle(input)

    // 读取原文件内容，生成diff预览（不应用编辑）
    const fullFilePath = normalizeFilePath(input.file_path)
    const enc = detectFileEncoding(fullFilePath)
    const originalContent = readFileSync(fullFilePath, enc)

    const patch = getPatch({
      filePath: fullFilePath,
      fileContents: originalContent,
      oldStr: input.old_string,
      newStr: input.new_string,
    })

    // 返回包含完整patch信息的JSON对象
    const content = {
      type: 'diff',
      patch: patch,
      diffText: ''
    }

    return {title, content}
  },
  genToolResultMessage({ filePath, structuredPatch }) {
    const title = getTitle({ file_path: filePath })
    const summary = getUpdateSummary(filePath, structuredPatch)
    const content = {
      type: 'diff',
      patch: structuredPatch,
      diffText: ''
    }

    return {title, summary, content}
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  async validateInput(
    { file_path, old_string, new_string, replace_all },
    agentContext: any
  ) {
    // 通过 agentContext 访问隔离状态
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)
    const readFileTimestamps = agentState.getReadFileTimestamps()
    if (old_string === new_string) {
      return {
        result: false,
        message:
          'No changes to make: old_string and new_string are exactly the same.',
        meta: {
          old_string,
        },
      } as ValidationResult
    }

    const fullFilePath = normalizeFilePath(file_path)

    if (existsSync(fullFilePath) && old_string === '') {
      return {
        result: false,
        message: 'Cannot create new file - file already exists.',
      }
    }

    if (!existsSync(fullFilePath) && old_string === '') {
      return {
        result: true,
      }
    }

    if (!existsSync(fullFilePath)) {
      // Try to find a similar file with a different extension
      const similarFilename = findSimilarFile(fullFilePath)
      let message = 'File does not exist.'

      // If we found a similar file, suggest it to the assistant
      if (similarFilename) {
        message += ` Did you mean ${similarFilename}?`
      }

      return {
        result: false,
        message,
      }
    }

    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        message: `File is a Jupyter Notebook. Use the ${NOTEBOOKEDIT_TOOL_NAME} to edit this file.`,
      }
    }

    const readTimestamp = readFileTimestamps[fullFilePath]
    if (!readTimestamp) {
      return {
        result: false,
        message:
          'File has not been read yet. Read it first before writing to it.',
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
      }
    }

    // Check if file exists and get its last modified time
    const stats = statSync(fullFilePath)
    const lastWriteTime = stats.mtimeMs
    if (lastWriteTime > readTimestamp) {
      return {
        result: false,
        message:
          'File has been unexpectedly modified. Read it again before attempting to write it.',
      }
    }

    const enc = detectFileEncoding(fullFilePath)
    const file = readFileSync(fullFilePath, enc)
    if (!file.includes(old_string)) {
      return {
        result: false,
        message: `String to replace not found in file.`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
      }
    }

    const matches = file.split(old_string).length - 1
    if (matches > 1 && !replace_all) {
      return {
        result: false,
        message: `Found ${matches} matches of the string to replace. For safety, this tool only supports replacing exactly one occurrence at a time. Add more lines of context to your edit, or set replace_all to true to replace all occurrences.`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
      }
    }

    return { result: true }
  },
  async *call({ file_path, old_string, new_string, replace_all }, agentContext: any) {
    const { patch, updatedFile } = applyEdit(file_path, old_string, new_string, replace_all)
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext.agentId)

    const fullFilePath = normalizeFilePath(file_path)
    const dir = dirname(fullFilePath)
    mkdirSync(dir, { recursive: true })
    const enc = existsSync(fullFilePath)
      ? detectFileEncoding(fullFilePath)
      : 'utf8'
    const endings = existsSync(fullFilePath)
      ? detectLineEndings(fullFilePath)
      : 'LF'
    const originalFile = existsSync(fullFilePath)
      ? readFileSync(fullFilePath, enc)
      : ''
    writeTextContent(fullFilePath, updatedFile, enc, endings)

    // Update read timestamp, to invalidate stale writes
    agentState.setReadFileTimestamp(fullFilePath, statSync(fullFilePath).mtimeMs)

    const data = {
      filePath: file_path,
      oldString: old_string,
      newString: new_string,
      originalFile,
      structuredPatch: patch,
    }
    yield {
      type: 'result',
      data,
      resultForAssistant: this.genResultForAssistant(data),
    }
  },
  genResultForAssistant({ filePath, originalFile, oldString, newString }) {
    const { snippet, startLine } = getSnippet(
      originalFile || '',
      oldString,
      newString,
    )
    return `The file ${filePath} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:
${addLineNumbers({
      content: snippet,
      startLine,
    })}`
  },
} satisfies Tool<
  typeof inputSchema,
  {
    filePath: string
    oldString: string
    newString: string
    originalFile: string
    structuredPatch: Hunk[]
  }
>

export function getSnippet(
  initialText: string,
  oldStr: string,
  newStr: string,
): { snippet: string; startLine: number } {
  const before = initialText.split(oldStr)[0] ?? ''
  const replacementLine = before.split(/\r?\n/).length - 1
  const newFileLines = initialText.replace(oldStr, newStr).split(/\r?\n/)
  // Calculate the start and end line numbers for the snippet
  const startLine = Math.max(0, replacementLine - N_LINES_SNIPPET)
  const endLine =
    replacementLine + N_LINES_SNIPPET + newStr.split(/\r?\n/).length
  // Get snippet
  const snippetLines = newFileLines.slice(startLine, endLine + 1)
  const snippet = snippetLines.join('\n')
  return { snippet, startLine: startLine + 1 }
}

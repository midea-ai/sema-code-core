import { Hunk } from 'diff'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { dirname, isAbsolute, relative } from 'path'
import { z } from 'zod'
import { Tool, ValidationResult } from './base/Tool'
import {
  inferFileEncoding,
  inferLineEndings,
  findFileWithDifferentExt,
  writeTextFile,
  formatWithLineNumbers,
  canonicalizeFilePath
} from '../util/file'
import { getPatch, getUpdateSummary } from '../util/diff'
import { readInitialCwd } from '../util/cwd'
import { TOOL_NAME_PATCH_FILE, TOOL_NAME_EDIT_NOTEBOOK } from '../prompt/tool'
import { applyEdit, normalizeLF } from '../util/edit'
import { getStateManager } from '../manager/StateManager'


const toolParams = z.strictObject({
  file_path: z.string().describe('Absolute path of the file to edit'),
  search_text: z.string().describe('The exact text in the file that should be replaced (must differ from replacement)'),
  replacement: z.string().describe('The new text to substitute in place of search_text (must differ from search_text)'),
  global_replace: z.boolean().optional().default(false).describe('When true, replace every occurrence of search_text in the file. Defaults to false (single match only).')
})

export type In = typeof toolParams

// 辅助函数：生成显示标题
function getTitle(input?: { file_path?: string }) {
  if (input?.file_path) {
    return relative(readInitialCwd(), input.file_path)
  }
  return TOOL_NAME_PATCH_FILE
}

// 构建 diff 类型的 content 对象
function makeDiffContent(patch: Hunk[]) {
  return { type: 'diff', patch, diffText: '' }
}

export const PatchFile = {
  name: TOOL_NAME_PATCH_FILE,
  description() {
    return `Replace an exact snippet in a file with new text.
You must read the file first. When copying text from its output, skip the line-number prefix — only match content after the tab.
\`search_text\` must be unique in the file. If not, include more surrounding lines to disambiguate, or set \`global_replace: true\` to replace every occurrence (useful for renames).
Always edit existing files rather than creating new ones. Never add emojis unless asked.`

  },
  toolParams,

  isSafe() {
    return false
  },
  genToolPermission(input) {
    const title = getTitle(input)

    // 读取原文件内容，生成diff预览（不应用编辑）
    // 统一转为 LF，保证 diff 计算与前端展示一致
    const fullFilePath = canonicalizeFilePath(input.file_path)
    const enc = inferFileEncoding(fullFilePath)
    const originalContent = normalizeLF(readFileSync(fullFilePath, enc))
    const normalizedOldStr = normalizeLF(input.search_text)
    const normalizedNewStr = normalizeLF(input.replacement)

    const patch = getPatch({
      filePath: fullFilePath,
      fileContents: originalContent,
      oldStr: normalizedOldStr,
      newStr: normalizedNewStr,
    })

    return { title, content: makeDiffContent(patch) }
  },
  genToolResultMessage({ filePath, structuredPatch }) {
    const title = getTitle({ file_path: filePath })
    const summary = getUpdateSummary(filePath, structuredPatch)
    return { title, summary, content: makeDiffContent(structuredPatch) }
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  async validateInput(
    { file_path, search_text, replacement, global_replace },
    agentContext: any
  ) {
    // 通过 agentContext 访问隔离状态
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)
    const readFileTimestamps = agentState.getReadFileTimestamps()
    if (search_text === replacement) {
      return {
        result: false,
        message:
          'search_text and replacement are identical — nothing to change.',
        meta: {
          search_text,
        },
      } as ValidationResult
    }

    const fullFilePath = canonicalizeFilePath(file_path)

    if (existsSync(fullFilePath) && search_text === '') {
      return {
        result: false,
        message: 'The file already exists; cannot create it again.',
      }
    }

    if (!existsSync(fullFilePath) && search_text === '') {
      return {
        result: true,
      }
    }

    if (!existsSync(fullFilePath)) {
      const similarFilename = findFileWithDifferentExt(fullFilePath)
      let message = 'The specified file was not found.'

      if (similarFilename) {
        message += ` Perhaps you meant ${similarFilename}?`
      }

      return {
        result: false,
        message,
      }
    }

    if (fullFilePath.endsWith('.ipynb')) {
      return {
        result: false,
        message: `This is a Jupyter Notebook — please use ${TOOL_NAME_EDIT_NOTEBOOK} instead.`,
      }
    }

    const readTimestamp = readFileTimestamps[fullFilePath]
    if (!readTimestamp) {
      return {
        result: false,
        message:
          'You need to read the file before editing it.',
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
      }
    }
    const stats = statSync(fullFilePath)
    const lastWriteTime = stats.mtimeMs
    if (lastWriteTime > readTimestamp) {
      return {
        result: false,
        message:
          'The file was modified externally since last read. Please re-read it before editing.',
      }
    }

    const enc = inferFileEncoding(fullFilePath)
    const rawFile = readFileSync(fullFilePath, enc)
    const file = normalizeLF(rawFile)
    const normalizedSearchText = normalizeLF(search_text)
    if (!file.includes(normalizedSearchText)) {
      // 生成诊断信息：显示 search_text 的前 100 个字符和文件开头 500 字符
      const searchTextPreview = normalizedSearchText.slice(0, 100).replace(/\n/g, '\\n')
      const filePreview = file.slice(0, 500).replace(/\n/g, '\\n')
      const fileLineEnding = rawFile.includes('\r\n') ? 'CRLF' : rawFile.includes('\r') ? 'CR' : 'LF'
      return {
        result: false,
        message: `The specified search_text does not exist in the file.\n\nDiagnostics:\n- Line endings: ${fileLineEnding}\n- search_text preview (100 chars): ${searchTextPreview}\n- File preview (500 chars): ${filePreview}`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
          fileLineEnding,
          searchTextLength: search_text.length,
          normalizedSearchTextLength: normalizedSearchText.length,
          fileLength: file.length,
        },
      }
    }

    const matches = file.split(normalizedSearchText).length - 1
    if (matches > 1 && !global_replace) {
      return {
        result: false,
        message: `Detected ${matches} occurrences of search_text. By default only a single unique match is allowed. Either include more surrounding context to narrow it down, or set global_replace to true.`,
        meta: {
          isFilePathAbsolute: String(isAbsolute(file_path)),
        },
      }
    }

    return { result: true }
  },
  async *call({ file_path, search_text, replacement, global_replace }, agentContext: any) {
    const { patch, updatedFile } = applyEdit(file_path, search_text, replacement, global_replace)
    const stateManager = getStateManager()
    const agentState = stateManager.forAgent(agentContext)

    const fullFilePath = canonicalizeFilePath(file_path)
    const dir = dirname(fullFilePath)
    mkdirSync(dir, { recursive: true })
    const fileExists = existsSync(fullFilePath)
    const enc = fileExists ? inferFileEncoding(fullFilePath) : 'utf8'
    const endings = fileExists ? (agentState.getFileLineEnding(fullFilePath) ?? inferLineEndings(fullFilePath)) : 'LF'
    const originalFile = fileExists
      ? normalizeLF(readFileSync(fullFilePath, enc))
      : ''

    // 权限确认后二次校验时间戳，防止用户在权限对话框期间修改文件
    if (fileExists) {
      const readTimestamp = agentState.getReadFileTimestamps()[fullFilePath]
      const currentMtime = statSync(fullFilePath).mtimeMs
      if (readTimestamp && currentMtime > readTimestamp) {
        throw new Error('The file changed while awaiting permission. Please re-read it before editing.')
      }
    }

    writeTextFile(fullFilePath, updatedFile, enc, endings)

    agentState.setReadFileTimestamp(fullFilePath, statSync(fullFilePath).mtimeMs)

    const data = {
      filePath: file_path,
      oldString: search_text,
      newString: replacement,
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
    const CONTEXT_LINES = 4
    const file = originalFile || ''
    const targetIdx = file.indexOf(oldString)
    const targetLine = targetIdx === -1
      ? 0
      : file.substring(0, targetIdx).split(/\r?\n/).length - 1

    const allLines = file.replace(oldString, newString).split(/\r?\n/)
    const replacementLineCount = newString ? newString.split(/\r?\n/).length : 0
    const start = Math.max(0, Math.min(targetLine - CONTEXT_LINES, allLines.length))
    const end = Math.max(0, Math.min(targetLine + CONTEXT_LINES + replacementLineCount, allLines.length))

    const snippet = allLines.slice(start, end).join('\n')
    const startLine = start + 1

    return `Successfully edited ${filePath}. Below is the updated snippet with line numbers:
${formatWithLineNumbers({ content: snippet, startLine })}`
  },
} satisfies Tool<
  typeof toolParams,
  {
    filePath: string
    oldString: string
    newString: string
    originalFile: string
    structuredPatch: Hunk[]
  }
>

import { z } from 'zod'
import { Tool } from './base/Tool'
import { readInitialCwd } from '../util/cwd'
import { globFiles, getDisplayPath } from '../util/file'
import { TOOL_NAME_SEARCH_FILES } from '../prompt/tool'

const TOOL_NAME = TOOL_NAME_SEARCH_FILES

function getTitle(input?: { pattern?: string; path?: string; glob?: string }) {
  if (input?.pattern !== undefined) {
    const parts = [`pattern: "${input.pattern}"`]

    if (input.glob) {
      parts.push(`glob: "${input.glob}"`)
    }

    if (input.path) {
      try {
        const displayPath = getDisplayPath(input.path)
        // 搜索目录就是项目根（`.`）时不显示位置
        if (displayPath !== '.') {
          parts.push(`path: "${displayPath}"`)
        }
      } catch (error) {
        parts.push(`path: "${input.path}"`)
      }
    }
    
    return `${parts.join(', ')}`
  }
  return TOOL_NAME
}

const toolParams = z.strictObject({
  pattern: z.string().describe('Glob pattern for matching file names (e.g. "**/*.ts", "src/**/*.json")'),
  path: z
    .string()
    .optional()
    .describe(
      'Root directory for the search. Defaults to the current working directory when omitted. Do not pass "undefined" or "null" — simply leave it out. Must point to an existing directory if provided.',
    ),
})

type ToolRes = {
  durationMs: number
  numFiles: number
  filenames: string[]
  truncated: boolean
  pattern?: string
  path?: string
}

export const SearchFiles = {
  name: TOOL_NAME,
  description() {
    return `Find files by name/path pattern using glob syntax (e.g. "**/*.ts", "src/**/index.js").
Results are ordered by last modified time.
For multi-step or exploratory searches, prefer the Agent tool.`
  },
  toolParams,
  isSafe() {
    return true
  },
  genToolResultMessage({ pattern = '', path, numFiles, filenames }) {
    const title = getTitle({ pattern, path })
    const fileText = numFiles !== 1 ? 'files' : 'file'
    
    // 文件路径按统一显示规则（项目内相对、项目外绝对）
    let content = ''
    if (filenames && filenames.length > 0) {
      const displayPaths = filenames.map(filePath => {
        try {
          return getDisplayPath(filePath)
        } catch (error) {
          return filePath
        }
      })

      content = displayPaths.join('\n')
    }
    
    return {
      title,
      summary: `Found ${numFiles} ${fileText}`,
      content
    }
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  async * call({ pattern, path }, agentContext: any) {
    const abortController = agentContext.abortController
    const start = Date.now()
    const { files, truncated } = await globFiles(
      pattern,
      path ?? readInitialCwd(),
      { limit: 100, offset: 0 },
      abortController?.signal ?? new AbortController().signal,
    )
    const output: ToolRes = {
      filenames: files,
      durationMs: Date.now() - start,
      numFiles: files.length,
      truncated,
      pattern,
      path,
    }
    yield {
      type: 'result',
      resultForAssistant: this.genResultForAssistant(output),
      data: output,
    }
  },
  genResultForAssistant(output) {
    let result = output.filenames.join('\n')
    if (output.filenames.length === 0) {
      result = 'No files found'
    }
    else if (output.truncated) {
      result +=
        '\n(Output truncated. Use a more specific path or pattern.)'
    }
    return result
  },
} satisfies Tool<typeof toolParams, ToolRes>
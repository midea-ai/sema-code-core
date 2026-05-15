import { stat } from 'fs/promises'
import { z } from 'zod'
import { relative } from 'path'
import { Tool } from './base/Tool'
import { readInitialCwd } from '../util/cwd'
import {
  canonicalizeFilePath,
} from '../util/file'
import { searchWithRipgrep } from '../util/ripgrep'
import { TOOL_NAME_SEARCH_CONTENT } from '../prompt/tool'
import { TOOL_DESCRIPTION } from '../prompt/tools/searchContent'

// 辅助函数：生成显示标题
function getTitle(input?: { pattern?: string; path?: string; glob?: string }) {
  if (input?.pattern !== undefined) {
    const parts = [`pattern: "${input.pattern}"`]
    
    if (input.glob) {
      parts.push(`glob: "${input.glob}"`)
    }
    
    if (input.path) {
      try {
        const absolutePath = canonicalizeFilePath(input.path)
        const relativePath = relative(readInitialCwd(), absolutePath)
        // 只有当相对路径不是空字符串或 '.' 时才添加
        if (relativePath && relativePath !== '.') {
          parts.push(`path: "${relativePath}"`)
        }
      } catch (error) {
        parts.push(`path: "${input.path}"`)
      }
    }
    
    return `${parts.join(', ')}`
  }
  return TOOL_NAME_SEARCH_CONTENT
}

const toolParams = z.strictObject({
  pattern: z
    .string()
    .describe('Regex pattern to match against file contents'),
  path: z
    .string()
    .optional()
    .describe(
      'Target file or directory for the search (passed as rg PATH). Uses the current working directory when omitted.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'File name filter using glob syntax (e.g. "*.ts", "*.{js,jsx}") — passed to rg --glob',
    ),
  file_type: z
    .string()
    .optional()
    .describe(
      'Restrict search to a specific file type (rg --type). Supported types include: js, ts, py, rust, go, java, etc. Preferred over glob for standard file types.',
    ),
  output_mode: z
    .enum(['content', 'files', 'count'])
    .optional()
    .describe(
      'Controls what is returned: "content" = matching lines with context and line numbers, "files" = only file paths containing a match, "count" = per-file match counts. Defaults to "files".',
    ),
  context_lines: z
    .number()
    .optional()
    .describe(
      'Lines of context to include before and after each match (rg -C). Only effective when output_mode is "content".',
    ),
  max_results: z
    .number()
    .optional()
    .describe(
      'Cap the output to the first N lines/entries. Applies to all output modes. Defaults to 0 (no limit).',
    ),
  ignore_case: z
    .boolean()
    .optional()
    .describe('Perform case-insensitive matching (rg -i)'),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Turn on multiline matching so that . also matches newlines and patterns can span across lines (rg -U --multiline-dotall). Defaults to false.',
    ),
})

const MAX_RESULTS = 100

type ToolRes = {
  durationMs: number
  numFiles: number
  filenames: string[]
  pattern?: string
  path?: string
  glob?: string
}

export const SearchContent = {
  name: TOOL_NAME_SEARCH_CONTENT,
  description() {
    return TOOL_DESCRIPTION
  },
  toolParams,
  isSafe() {
    return true
  },
  genToolResultMessage({ pattern = '', path, glob, numFiles, filenames }) {
    const title = getTitle({ pattern, path, glob })
    const matchText = numFiles !== 1 ? 'matches' : 'match';
    
    // 将文件路径转换为相对路径
    let content = ''
    if (filenames && filenames.length > 0) {
      const relativeFilePaths = filenames.map(line => {
        try {
          // 检查是否是 "文件路径:行号:内容" 格式（content 模式）
          const match = line.match(/^(.+?):(\d+)(:.*)?$/)
          if (match) {
            const [, filePath, lineNum, rest = ''] = match
            const relativePath = relative(readInitialCwd(), filePath)
            return `${relativePath}:${lineNum}${rest}`
          }
          // 普通文件路径（files 模式）
          return relative(readInitialCwd(), line)
        } catch (error) {
          return line
        }
      })

      content = relativeFilePaths.join('\n')
    }
    
    return {
      title,
      summary: `Found ${numFiles} ${matchText}`,
      content
    }
  },
  genResultForAssistant({ numFiles, filenames }) {
    if (numFiles === 0) {
      return 'No matches found'
    }
    let result = `Found ${numFiles} match${numFiles === 1 ? '' : 'es'}\n${filenames.slice(0, MAX_RESULTS).join('\n')}`
    if (numFiles > MAX_RESULTS) {
      result +=
        '\n(Output truncated. Use a more specific path or pattern.)'
    }
    return result
  },
  getDisplayTitle(input) {
    return getTitle(input)
  },
  async *call(input, agentContext: any) {
    const abortController = agentContext.abortController
    const {
      pattern,
      path,
      glob,
      output_mode = 'files',
      context_lines,
      max_results = 0,
      ignore_case,
      file_type,
      multiline,
    } = input

    const start = Date.now()
    const absolutePath = path ? canonicalizeFilePath(path) : readInitialCwd()

    // 构建 ripgrep 参数
    const args: string[] = []

    // 输出模式
    switch (output_mode) {
      case 'files':
        args.push('-l') // 只显示匹配的文件名
        break
      case 'content':
        // content 模式默认带行号
        args.push('-n')
        break
      case 'count':
        args.push('-c') // 显示匹配计数
        break
    }

    // 大小写敏感性
    if (ignore_case) {
      args.push('-i')
    }

    // 上下文行
    if (context_lines !== undefined) {
      args.push('-C', context_lines.toString())
    }

    // 多行模式
    if (multiline) {
      args.push('-U', '--multiline-dotall')
    }

    // 文件类型过滤
    if (file_type) {
      args.push('--type', file_type)
    }

    // Glob 模式
    if (glob) {
      args.push('--glob', glob)
    }

    // 添加模式
    args.push(pattern)

    const results = await searchWithRipgrep(args, absolutePath, abortController?.signal)

    // 处理结果数量限制
    let processedResults = results
    if (max_results > 0) {
      processedResults = processedResults.slice(0, max_results)
    }

    // 对于文件列表模式，按修改时间排序
    if (output_mode === 'files') {
      try {
        const stats = await Promise.all(processedResults.map(_ => stat(_)))
        const matches = processedResults
          .map((_, i) => [_, stats[i]!] as const)
          .sort((a, b) => {
            const timeComparison = (b[1].mtimeMs ?? 0) - (a[1].mtimeMs ?? 0)
            if (timeComparison === 0) {
              return a[0].localeCompare(b[0])
            }
            return timeComparison
          })
          .map(_ => _[0])

        processedResults = matches
      } catch (error) {
        // 如果获取文件状态失败，保持原始顺序
        console.warn('Failed to get file stats for sorting:', error)
      }
    }

    // 在 content 模式下，需要统计实际匹配数，而不是输出行数
    // ripgrep 输出格式（带行号 -n）：
    //   单文件: "123:content" (匹配), "124-context" (上下文)
    //   多文件: "file:123:content" (匹配), "file-124-context" (上下文)
    //   分隔符: "--"
    let actualMatchCount = processedResults.length

    if (output_mode === 'content') {
      // content 模式始终带行号，匹配行的特征是包含 ":数字:" 或以 "数字:" 开头
      // 上下文行的特征是包含 "-数字-" 或以 "数字-" 开头
      actualMatchCount = processedResults.filter(line => {
        if (line === '--') return false
        // 单文件格式: "123:content"
        if (/^\d+:/.test(line)) return true
        // 多文件格式: "path:123:content"
        if (/:(\d+):/.test(line)) return true
        return false
      }).length
    } else if (output_mode === 'count') {
      // count 模式下，每行格式是 "file:count"
      // numFiles 应该是文件数，不是匹配总数
      actualMatchCount = processedResults.length
    }

    const output = {
      filenames: processedResults,
      durationMs: Date.now() - start,
      numFiles: actualMatchCount,
      pattern,
      path,
      glob,
    }

    yield {
      type: 'result',
      resultForAssistant: this.genResultForAssistant(output),
      data: output,
    }
  },
} satisfies Tool<typeof toolParams, ToolRes>
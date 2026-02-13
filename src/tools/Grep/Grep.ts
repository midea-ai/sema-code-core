import { stat } from 'fs/promises'
import { z } from 'zod'
import { relative } from 'path'
import { Tool } from '../base/Tool'
import { getCwd } from '../../util/cwd'
import {
  normalizeFilePath,
} from '../../util/file'
import { ripGrep } from '../../util/ripgrep'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'

// 辅助函数：生成显示标题
function getTitle(input?: { pattern?: string; path?: string; glob?: string }) {
  if (input?.pattern !== undefined) {
    const parts = [`pattern: "${input.pattern}"`]
    
    // 调整顺序：glob 在 path 之前
    if (input.glob) {
      parts.push(`glob: "${input.glob}"`)
    }
    
    if (input.path) {
      try {
        const absolutePath = normalizeFilePath(input.path)
        const relativePath = relative(getCwd(), absolutePath)
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
  return TOOL_NAME_FOR_PROMPT
}

const inputSchema = z.strictObject({
  pattern: z
    .string()
    .describe('The regular expression pattern to search for in file contents'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in (rg PATH). Defaults to current working directory.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
    ),
  '-A': z
    .number()
    .optional()
    .describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
  '-B': z
    .number()
    .optional()
    .describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
  '-C': z
    .number()
    .optional()
    .describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
  '-n': z
    .boolean()
    .optional()
    .describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
  '-i': z
    .boolean()
    .optional()
    .describe('Case insensitive search (rg -i)'),
  type: z
    .string()
    .optional()
    .describe(
      'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
    ),
  head_limit: z
    .number()
    .optional()
    .describe(
      'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 0 (unlimited).',
    ),
  offset: z
    .number()
    .optional()
    .describe(
      'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
    ),
})

const MAX_RESULTS = 100

type Output = {
  durationMs: number
  numFiles: number
  filenames: string[]
  pattern?: string
  path?: string
  glob?: string
}

export const GrepTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  genToolResultMessage({ pattern = '', path, glob, numFiles, filenames }) {
    const title = getTitle({ pattern, path, glob })
    const matchText = numFiles !== 1 ? 'matches' : 'match';
    
    // 格式化内容：显示最多10个文件，超出部分显示省略信息
    let content = ''
    if (filenames && filenames.length > 0) {
      const maxDisplayCount = 10
      const displayFiles = filenames.slice(0, maxDisplayCount)
      const remainingCount = filenames.length - maxDisplayCount
      
      // 将文件路径转换为相对路径
      // 注意：content 模式下，每行格式为 "文件路径:行号:内容"，需要单独处理路径部分
      const relativeFilePaths = displayFiles.map(line => {
        try {
          // 检查是否是 "文件路径:行号:内容" 格式（content 模式）
          // 匹配格式：/path/to/file:123:content 或 /path/to/file:123
          const match = line.match(/^(.+?):(\d+)(:.*)?$/)
          if (match) {
            const [, filePath, lineNum, rest = ''] = match
            const relativePath = relative(getCwd(), filePath)
            return `${relativePath}:${lineNum}${rest}`
          }
          // 普通文件路径（files_with_matches 模式）
          return relative(getCwd(), line)
        } catch (error) {
          return line
        }
      })
      
      content = relativeFilePaths.join('\n')
      
      if (remainingCount > 0) {
        content += `\n... (+${remainingCount} files)`
      }
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
        '\n(Results are truncated. Consider using a more specific path or pattern.)'
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
      output_mode = 'files_with_matches',
      '-A': afterContext,
      '-B': beforeContext,
      '-C': context,
      '-n': showLineNumbers = true,
      '-i': caseInsensitive,
      type,
      head_limit = 0,
      offset = 0,
      multiline,
    } = input

    const start = Date.now()
    const absolutePath = path ? normalizeFilePath(path) : getCwd()

    // 构建 ripgrep 参数
    const args: string[] = []

    // 输出模式
    switch (output_mode) {
      case 'files_with_matches':
        args.push('-l') // 只显示匹配的文件名
        break
      case 'content':
        // 默认显示内容，可能需要行号
        if (showLineNumbers) {
          args.push('-n')
        }
        break
      case 'count':
        args.push('-c') // 显示匹配计数
        break
    }

    // 大小写敏感性
    if (caseInsensitive) {
      args.push('-i')
    }

    // 上下文行
    if (context !== undefined) {
      args.push('-C', context.toString())
    } else {
      if (beforeContext !== undefined) {
        args.push('-B', beforeContext.toString())
      }
      if (afterContext !== undefined) {
        args.push('-A', afterContext.toString())
      }
    }

    // 多行模式
    if (multiline) {
      args.push('-U', '--multiline-dotall')
    }

    // 文件类型过滤
    if (type) {
      args.push('--type', type)
    }

    // Glob 模式
    if (glob) {
      args.push('--glob', glob)
    }

    // 添加模式
    args.push(pattern)

    const results = await ripGrep(args, absolutePath, abortController?.signal ?? new AbortController().signal)

    // 处理分页（offset 和 head_limit）
    let processedResults = results
    if (offset > 0) {
      processedResults = processedResults.slice(offset)
    }
    if (head_limit > 0) {
      processedResults = processedResults.slice(0, head_limit)
    }

    // 对于文件列表模式，按修改时间排序
    if (output_mode === 'files_with_matches') {
      try {
        const stats = await Promise.all(processedResults.map(_ => stat(_)))
        const matches = processedResults
          .map((_, i) => [_, stats[i]!] as const)
          .sort((a, b) => {
            const timeComparison = (b[1].mtimeMs ?? 0) - (a[1].mtimeMs ?? 0)
            if (timeComparison === 0) {
              // Sort by filename as a tiebreaker
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
      if (showLineNumbers) {
        // 带行号模式：匹配行的特征是包含 ":数字:" 或以 "数字:" 开头
        // 上下文行的特征是包含 "-数字-" 或以 "数字-" 开头
        actualMatchCount = processedResults.filter(line => {
          // 排除分隔符
          if (line === '--') return false

          // 检查是否是匹配行
          // 单文件格式: "123:content"
          if (/^\d+:/.test(line)) return true

          // 多文件格式: "path:123:content"
          // 需要确保不是上下文行 "path-123-content"
          if (/:(\d+):/.test(line)) return true

          return false
        }).length
      } else {
        // 无行号模式：匹配行用冒号分隔，上下文行用减号分隔
        // 单文件: "content" vs "content" (难以区分)
        // 多文件: "file:content" vs "file-content"
        actualMatchCount = processedResults.filter(line => {
          if (line === '--') return false

          // 在无行号模式下，通过分隔符类型判断
          // 如果包含 "路径:" 但不包含 "路径-"，则是匹配行
          const colonMatch = line.match(/^([^:]+):/)
          const dashMatch = line.match(/^([^-]+)-/)

          // 有冒号且冒号在减号之前（或没有减号）
          if (colonMatch) {
            if (!dashMatch) return true
            return line.indexOf(':') < line.indexOf('-')
          }

          return false
        }).length
      }
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
} satisfies Tool<typeof inputSchema, Output>
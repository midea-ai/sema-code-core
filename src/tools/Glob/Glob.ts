import { z } from 'zod'
import { relative } from 'path'
import { Tool } from '../base/Tool'
import { getCwd } from '../../util/cwd'
import { getAbsolutePath } from '../../util/file'
import { glob } from '../../util/file'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'

function getTitle(input?: { pattern?: string; path?: string; glob?: string }) {
  if (input?.pattern !== undefined) {
    const parts = [`pattern: "${input.pattern}"`]
    
    if (input.glob) {
      parts.push(`glob: "${input.glob}"`)
    }
    
    if (input.path) {
      try {
        const absolutePath = getAbsolutePath(input.path) || input.path
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
  pattern: z.string().describe('The glob pattern to match files against'),
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.',
    ),
})

type Output = {
  durationMs: number
  numFiles: number
  filenames: string[]
  truncated: boolean
  pattern?: string
  path?: string
}

export const GlobTool = {
  name: TOOL_NAME_FOR_PROMPT,
  description() {
    return DESCRIPTION
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  genToolResultMessage({ pattern = '', path, numFiles, filenames }) {
    const title = getTitle({ pattern, path })
    const fileText = numFiles !== 1 ? 'files' : 'file'
    
    // 最多显示10行，后面显示 '`\n... (+${剩余文件数} files)`'
    let content = ''
    if (filenames && filenames.length > 0) {
      const maxDisplayCount = 10
      const displayFiles = filenames.slice(0, maxDisplayCount)
      const remainingCount = filenames.length - maxDisplayCount
      
      // 将文件路径转换为相对路径
      const relativeFilePaths = displayFiles.map(filePath => {
        try {
          return relative(getCwd(), filePath)
        } catch (error) {
          return filePath
        }
      })
      
      content = relativeFilePaths.join('\n')
      
      // 如果有剩余文件，显示省略信息
      if (remainingCount > 0) {
        content += `\n... (+${remainingCount} files)`
      }
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
    const { files, truncated } = await glob(
      pattern,
      path ?? getCwd(),
      { limit: 100, offset: 0 },
      abortController?.signal ?? new AbortController().signal,
    )
    const output: Output = {
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
    // Only add truncation message if results were actually truncated
    else if (output.truncated) {
      result +=
        '\n(Results are truncated. Consider using a more specific path or pattern.)'
    }
    return result
  },
} satisfies Tool<typeof inputSchema, Output>
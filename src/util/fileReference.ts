import Anthropic from '@anthropic-ai/sdk'
import { canonicalizeFilePath } from './file'
import { logWarn, logInfo } from './log'
import { VIEW_FILE_MAX_LINES as READ_MAX_LINES } from '../prompt/tools/viewFile'
import { DOC_NOT_SUPPORTED_MESSAGE } from '../tools/ViewFile'
import { TOOL_NAME_VIEW_FILE, TOOL_NAME_RUN_SHELL } from '../prompt/tool'
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from '../prompt/define'
import { FileReferenceInfo } from '../types/index'
import { readInitialCwd } from './cwd'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 文件引用信息类型定义
 */

export interface ParsedFileReference {
  fileName: string
  startLine?: number
  endLine?: number
  isDirectory?: boolean
}

/**
 * 解析文件引用字符串
 * 支持格式：
 * - @filename - 读取整个文件
 * - @filename:line - 读取指定行（如 @index.js:13）
 * - @filename:start-end - 读取行号范围（如 @index.js:13-17）
 * - @dirname - 列出目录内容（如果是目录）
 */
export function parseFileReference(reference: string): ParsedFileReference {
  // 移除 @ 符号
  const cleanRef = reference.startsWith('@') ? reference.slice(1) : reference

  // 检查是否包含行号信息
  const colonIndex = cleanRef.lastIndexOf(':')
  if (colonIndex === -1) {
    // 没有行号，检查是否为目录
    const fullPath = canonicalizeFilePath(cleanRef)
    let isDirectory = false
    try {
      const stats = fs.statSync(fullPath)
      isDirectory = stats.isDirectory()
    } catch (error) {
      // 文件/目录不存在或无法访问，当作文件处理
      isDirectory = false
    }

    return {
      fileName: cleanRef,
      isDirectory
    }
  }

  const fileName = cleanRef.slice(0, colonIndex)
  const lineInfo = cleanRef.slice(colonIndex + 1)

  // 检查是否为范围格式 (start-end)
  if (lineInfo.includes('-')) {
    const [startStr, endStr] = lineInfo.split('-', 2)
    const startLine = parseInt(startStr, 10)
    const endLine = parseInt(endStr, 10)

    if (isNaN(startLine) || isNaN(endLine)) {
      // 无效的行号格式，当作普通文件名处理
      return { fileName: cleanRef }
    }

    return {
      fileName,
      startLine: Math.max(1, startLine), // 确保行号至少为1
      endLine: Math.max(startLine, endLine) // 确保结束行号不小于开始行号
    }
  } else {
    // 单行格式
    const lineNumber = parseInt(lineInfo, 10)
    if (isNaN(lineNumber)) {
      // 无效的行号格式，当作普通文件名处理
      return { fileName: cleanRef }
    }

    const validLineNumber = Math.max(1, lineNumber)
    return {
      fileName,
      startLine: validLineNumber,
      endLine: validLineNumber
    }
  }
}

/**
 * 处理目录引用,调用 ls 命令列出目录内容
 * 返回处理结果而不是修改传入数组，以支持并行处理
 */
async function processDirectoryReference(
  fullPath: string,
  agentContext: any
): Promise<{
  systemReminders: Anthropic.ContentBlockParam[];
  supplementaryInfo: FileReferenceInfo[];
}> {
  const systemReminders: Anthropic.ContentBlockParam[] = []
  const supplementaryInfo: FileReferenceInfo[] = []

  // 获取 Bash 工具
  const bashTool = agentContext.tools.find((t: any) => t.name === TOOL_NAME_RUN_SHELL)
  if (!bashTool) {
    logWarn(`${TOOL_NAME_RUN_SHELL} tool not found, cannot list directory contents`)
    return { systemReminders, supplementaryInfo }
  }

  const bashToolCallInfo = `{"command":"ls \\"${fullPath}\\""}`
  systemReminders.push({
    type: 'text' as const,
    text: `${REMINDER_SYS_OPEN}\nCalled the ${TOOL_NAME_RUN_SHELL} tool with the following input: ${bashToolCallInfo}\n${REMINDER_SYS_CLOSE}`
  })

  // 调用 Bash 工具列出目录内容（覆盖 agentId 避免触发 chunk 事件）
  const bashGenerator = bashTool.call(
    {
      command: `ls "${fullPath}"`,
      description: `Lists files in ${fullPath}`
    },
    { ...agentContext, agentId: 'fileReference' }
  )

  for await (const result of bashGenerator) {
    if (result.type === 'result') {
      const content = result.resultForAssistant?.replace(/"/g, '\\"') || ''
      systemReminders.push({
        type: 'text' as const,
        text: `${REMINDER_SYS_OPEN}\nResult of calling the ${TOOL_NAME_RUN_SHELL} tool: "${content}"\n${REMINDER_SYS_CLOSE}`
      })

      // 添加补充信息
      const relativeName = path.relative(readInitialCwd(), fullPath) || path.basename(fullPath)
      const displayName = relativeName.endsWith('/') ? relativeName : `${relativeName}/`
      supplementaryInfo.push({
        type: 'dir',
        name: displayName,
        content: `Listed directory ${displayName}`
      })

      break // 只需要第一个结果
    }
  }

  return { systemReminders, supplementaryInfo }
}

/**
 * 处理单个文件引用（文件或目录）
 * 返回处理结果，以支持并行处理
 */
async function processSingleReference(
  match: RegExpMatchArray,
  agentContext: any,
  fileReadTool: any
): Promise<{
  systemReminders: Anthropic.ContentBlockParam[];
  supplementaryInfo: FileReferenceInfo[];
}> {
  const systemReminders: Anthropic.ContentBlockParam[] = []
  const supplementaryInfo: FileReferenceInfo[] = []

  const fullReference = match[0] // 完整的引用字符串，如 @index.js:13-17
  const referenceText = match[1] // 去掉@的部分，如 index.js:13-17

  // 解析文件引用
  const parsed = parseFileReference(referenceText)
  const fullPath = canonicalizeFilePath(parsed.fileName)

  logInfo(`Processing file reference: ${fullReference} -> ${fullPath}${parsed.startLine ? `:${parsed.startLine}${parsed.endLine !== parsed.startLine ? `-${parsed.endLine}` : ''}` : ''}`)

  try {
    // 检查是否为目录引用
    if (parsed.isDirectory) {
      return await processDirectoryReference(fullPath, agentContext)
    }

    // 检查是否为 PDF 文件
    if (path.extname(fullPath).toLowerCase() === '.pdf') {
      systemReminders.push({
        type: 'text' as const,
        text: `${REMINDER_SYS_OPEN}\nPDF files are supported by the ${TOOL_NAME_VIEW_FILE} tool. Specify page ranges via the pages parameter (e.g., pages: "1-5"). Limit: 20 pages per request.\n${REMINDER_SYS_CLOSE}`
      })
      // 不再直接返回,让 view_file 工具处理 PDF
    }

    // 检查是否为 DOC/DOCX 文件
    const docExt = path.extname(fullPath).toLowerCase()
    if (docExt === '.doc' || docExt === '.docx') {
      systemReminders.push({
        type: 'text' as const,
        text: `${REMINDER_SYS_OPEN}\n${DOC_NOT_SUPPORTED_MESSAGE}\n${REMINDER_SYS_CLOSE}`
      })
      return { systemReminders, supplementaryInfo }
    }

    // 智能处理行数范围
    let actualStartLine = parsed.startLine
    let actualLimit = parsed.startLine !== undefined && parsed.endLine !== undefined
      ? parsed.endLine - parsed.startLine + 1
      : undefined
    let shouldCheckTruncation = false // 标记是否需要检查截断

    // 如果结束行小于等于 READ_MAX_LINES，读取全文（不使用 offset 和 limit）
    if (parsed.endLine !== undefined && parsed.endLine <= READ_MAX_LINES) {
      actualStartLine = undefined
      actualLimit = undefined
    }
    // 如果请求的行数范围超过最大限制，以中位数为中心读取
    else if (actualLimit && actualLimit > READ_MAX_LINES) {
      const requestedStart = parsed.startLine!
      const requestedEnd = parsed.endLine!
      const midPoint = Math.floor((requestedStart + requestedEnd) / 2)

      // 以中位数为中心，向上下扩展，总共读取 READ_MAX_LINES 行
      const halfRange = Math.floor(READ_MAX_LINES / 2)
      actualStartLine = Math.max(1, midPoint - halfRange)
      actualLimit = READ_MAX_LINES

      logWarn(`File reference ${fullReference} requested ${parsed.endLine! - parsed.startLine! + 1} lines, ` +
        `limiting to ${READ_MAX_LINES} lines centered around line ${midPoint} ` +
        `(reading lines ${actualStartLine}-${actualStartLine + actualLimit - 1})`)
    }
    // 如果没有指定行号范围，由 view_file 工具默认 limit 处理截断
    else if (parsed.startLine === undefined) {
      shouldCheckTruncation = true
    }

    let toolCallInfo: string
    if (actualStartLine !== undefined) {
      toolCallInfo = `{"file_path":"${fullPath}","start_line":${actualStartLine},"max_lines":${actualLimit}}`
    } else if (actualLimit !== undefined) {
      toolCallInfo = `{"file_path":"${fullPath}","max_lines":${actualLimit}}`
    } else {
      toolCallInfo = `{"file_path":"${fullPath}"}`
    }

    systemReminders.push({
      type: 'text' as const,
      text: `${REMINDER_SYS_OPEN}\nCalled the ${TOOL_NAME_VIEW_FILE} tool with the following input: ${toolCallInfo}\n${REMINDER_SYS_CLOSE}`
    })

    // 构建ViewFileTool的参数
    const toolParams: any = { file_path: fullPath }
    if (actualStartLine !== undefined) {
      toolParams.start_line = actualStartLine
    }
    if (actualLimit !== undefined) {
      toolParams.max_lines = actualLimit
    }

    // 调用ViewFileTool读取文件
    const readGenerator = fileReadTool.call(
      toolParams,
      agentContext
    )

    for await (const result of readGenerator) {
      if (result.type === 'result') {
        const displayName = path.relative(readInitialCwd(), fullPath) || path.basename(fullPath)

        // 检查是否为图片文件
        if (result.data.type === 'image') {
          // 注入图片 content block
          systemReminders.push({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              data: result.data.image.data,
              media_type: result.data.image.media_type,
            },
          })

          let sizeStr = ''
          try {
            const bytes = fs.statSync(fullPath).size
            sizeStr = bytes >= 1024 * 1024
              ? ` (${(bytes / (1024 * 1024)).toFixed(2)}MB)`
              : ` (${(bytes / 1024).toFixed(1)}KB)`
          } catch { /* ignore */ }

          supplementaryInfo.push({
            type: 'file',
            name: displayName,
            content: `Read ${displayName}${sizeStr}`,
          })
        } else if (result.data.type === 'notebook') {
          // Notebook 文件格式化为 JSON 数组格式
          const content = result.resultForAssistant || ''
          const jsonContent = JSON.stringify([{
            text: content,
            type: 'text'
          }])

          systemReminders.push({
            type: 'text' as const,
            text: `${REMINDER_SYS_OPEN}\nResult of calling the ${TOOL_NAME_VIEW_FILE} tool: ${jsonContent}\n${REMINDER_SYS_CLOSE}`
          })

          // 添加补充信息
          const cellCount = result.data.notebook.cellCount
          supplementaryInfo.push({
            type: 'file',
            name: displayName,
            content: `Read ${displayName} (${cellCount} cells)`
          })
        } else {
          // 普通文本文件
          const content = result.resultForAssistant?.replace(/"/g, '\\"') || ''
          systemReminders.push({
            type: 'text' as const,
            text: `${REMINDER_SYS_OPEN}\nResult of calling the ${TOOL_NAME_VIEW_FILE} tool: "${content}"\n${REMINDER_SYS_CLOSE}`
          })

          // 添加补充信息
          const lineCount = content.split('\n').length
          const isTruncated = shouldCheckTruncation && lineCount >= READ_MAX_LINES
          supplementaryInfo.push({
            type: 'file',
            name: displayName,
            content: isTruncated
              ? `Read ${displayName} (${READ_MAX_LINES}+ lines)`
              : `Read ${displayName} (${lineCount} lines)`
          })

          // 检查是否被截断（当设置了limit且行数达到限制时）
          if (isTruncated) {
            systemReminders.push({
              type: 'text' as const,
              text: `${REMINDER_SYS_OPEN}\nNote: ${fullPath} was truncated to the first ${READ_MAX_LINES} lines. Read more if needed.\n${REMINDER_SYS_CLOSE}`
            })
          }
        }

        break // 只需要第一个结果
      }
    }
  } catch (error) {
    // 处理文件读取错误
    const errorMessage = error instanceof Error ? error.message : String(error)
    logWarn(`Error reading file ${parsed.fileName}: ${errorMessage}`)
    systemReminders.push({
      type: 'text' as const,
      text: `${REMINDER_SYS_OPEN}\nError reading file ${parsed.fileName}: ${errorMessage}\n${REMINDER_SYS_CLOSE}`
    })
  }

  return { systemReminders, supplementaryInfo }
}

/**
 * 处理用户输入中的文件引用 (@filename 或 @filename:lines)
 * read工具自动读取引用的文件并将内容注入
 * bash工具调用 ls 命令列出目录内容
 * 多文件目录均并行执行
 * 结果顺序也保持原有顺序（按用户输入中引用出现的顺序）
 */
export async function processFileReferences(
  userInput: string,
  agentContext: any
): Promise<{
  systemReminders: Anthropic.ContentBlockParam[];
  supplementaryInfo: FileReferenceInfo[];
}> {
  // @ 引用的边界字符：空白 + 常见中英文标点
  // 不含 . : / \ 等路径合法字符，避免截断文件名/路径
  // 左边界：@ 必须位于行首或边界字符之后（避免误匹配 email@example.com 等）
  // 右边界：遇到边界字符则停止
  const fileReferenceRegex = /(?:^|(?<=[\s。，、；：！？""''「」『』（）《》〈〉【】,;!?]))@([^\s。，、；：！？""''「」『』（）《》〈〉【】,;!?]+)/g
  const allMatches = [...userInput.matchAll(fileReferenceRegex)]

  // 如果没有找到文件引用,直接返回
  if (allMatches.length === 0) {
    return { systemReminders: [], supplementaryInfo: [] }
  }

  // 对文件引用进行去重，保持首次出现的顺序
  const seen = new Set<string>()
  const matches = allMatches.filter(match => {
    const ref = match[1]
    if (seen.has(ref)) {
      return false
    }
    seen.add(ref)
    return true
  })

  // 从 agentContext 获取工具列表
  const fileReadTool = agentContext.tools.find((t: any) => t.name === TOOL_NAME_VIEW_FILE)

  if (!fileReadTool) {
    logWarn('ViewFile tool not found, skipping file reference processing')
    return { systemReminders: [], supplementaryInfo: [] }
  }

  // 并行处理所有文件和目录引用
  const results = await Promise.all(
    matches.map(match => processSingleReference(match, agentContext, fileReadTool))
  )

  // 合并所有结果，保持原有顺序
  const systemReminders: Anthropic.ContentBlockParam[] = []
  const supplementaryInfo: FileReferenceInfo[] = []

  for (const result of results) {
    systemReminders.push(...result.systemReminders)
    supplementaryInfo.push(...result.supplementaryInfo)
  }

  return { systemReminders, supplementaryInfo }
}

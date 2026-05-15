import { logError } from './log'
import { TOOL_NAME_SEARCH_CONTENT } from '../prompt/tool'

export function safeParseJSON(json: string | null | undefined): unknown {
  if (!json) {
    return null
  }
  try {
    return JSON.parse(json)
  } catch (e) {
    logError(e)
    return null
  }
}

/**
 * 格式化文件大小为人类可读的格式
 */
export function formatFileSizeError(sizeInBytes: number, limitBytes: number): string {
  return `File size (${formatSize(sizeInBytes)}) exceeds the ${formatSize(limitBytes)} limit. Use offset and limit to read a portion, or use ${TOOL_NAME_SEARCH_CONTENT} to search for specific content.`
}

export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

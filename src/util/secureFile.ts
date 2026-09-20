import { existsSync, statSync } from 'node:fs'
import { canonicalizeFilePath } from './file'

const MAX_PATH_LENGTH = 4096

/**
 * 获取文件信息，仅做与权限无关的基础校验（路径长度、存在性）。
 * 读取位置是否允许由 PermissionManager 按 classifyReadPath 裁决，这里不做位置判断。
 */
export function safeGetFileInfo(filePath: string): {
  success: boolean
  stats?: {
    size: number
    isFile: boolean
    isDirectory: boolean
    mode: number
    atime: Date
    mtime: Date
    ctime: Date
  }
  error?: string
} {
  try {
    const normalizedPath = canonicalizeFilePath(filePath)

    if (normalizedPath.length > MAX_PATH_LENGTH) {
      return { success: false, error: `Path too long (max ${MAX_PATH_LENGTH} characters)` }
    }

    if (!existsSync(normalizedPath)) {
      return { success: false, error: `File '${normalizedPath}' does not exist` }
    }

    const stats = statSync(normalizedPath)

    return {
      success: true,
      stats: {
        size: stats.size,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        mode: stats.mode,
        atime: stats.atime,
        mtime: stats.mtime,
        ctime: stats.ctime
      }
    }
  } catch (error) {
    return {
      success: false,
      error: `Failed to get file info: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

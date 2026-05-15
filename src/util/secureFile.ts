import { existsSync, statSync } from 'node:fs'
import { relative, isAbsolute } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { canonicalizeFilePath } from './file'
import { readInitialCwd } from './cwd'
import { logDebug } from './log'

const STATIC_BASE_PATHS = [homedir(), '/tmp', '/var/tmp', tmpdir()]

const SUSPICIOUS_PATTERNS = [
  /\.\./,
  /~/,
  /\$\{/,
  /`/,
  /\|/,
  /;/,
  /&/,
  />/,
  /</,
]

function validateFilePath(filePath: string): { isValid: boolean; normalizedPath: string; error?: string } {
  try {
    const normalizedPath = canonicalizeFilePath(filePath)

    if (normalizedPath.length > 4096) {
      return { isValid: false, normalizedPath, error: 'Path too long (max 4096 characters)' }
    }

    for (const pattern of SUSPICIOUS_PATTERNS) {
      if (pattern.test(normalizedPath)) {
        return { isValid: false, normalizedPath, error: `Path contains suspicious pattern: ${pattern}` }
      }
    }

    const allowedPaths = [readInitialCwd(), ...STATIC_BASE_PATHS]

    const isInAllowedPath = allowedPaths.some(basePath => {
      const base = canonicalizeFilePath(basePath)
      const rel = relative(base, normalizedPath)
      if (!rel || rel === '') return true
      if (rel.startsWith('..')) {
        logDebug('[SecureFileService] path escapes base, denied')
        return false
      }
      if (isAbsolute(rel)) {
        logDebug('[SecureFileService] absolute relative path, denied')
        return false
      }
      return true
    })

    if (!isInAllowedPath) {
      return { isValid: false, normalizedPath, error: 'Path is outside allowed directories' }
    }

    return { isValid: true, normalizedPath }
  } catch (error) {
    return {
      isValid: false,
      normalizedPath: filePath,
      error: `Path validation failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

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
  const validation = validateFilePath(filePath)
  if (!validation.isValid) {
    return { success: false, error: validation.error }
  }

  try {
    const normalizedPath = validation.normalizedPath

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

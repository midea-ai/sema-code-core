import { findActualExecutable } from 'spawn-rx'
import { memoize } from 'lodash-es'
import { logError } from './log'
import { execFile } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import { exeName, unixDriveToNative } from './platform'

/**
 * 使用 ripgrep 执行文件内容搜索
 */
export async function searchWithRipgrep(
  searchArgs: string[],
  searchPath: string,
  abortSignal?: AbortSignal,
): Promise<string[]> {
  const ripgrepExecutable = getRipgrepPath()
  const nativeSearchPath = unixDriveToNative(searchPath)

  return new Promise((resolve) => {
    execFile(
      ripgrepExecutable,
      [...searchArgs, nativeSearchPath],
      {
        maxBuffer: 512_000,
        ...(abortSignal && { signal: abortSignal }),
        timeout: 8_000,
      },
      (error, stdout) => {
        if (error) {
          // 退出码 1 表示未找到匹配，属于正常情况；其他错误记录日志
          const code = error.code
          const exitCode = typeof code === 'number' ? code : typeof code === 'string' ? parseInt(code, 10) : undefined
          if (exitCode !== 1) {
            logError(`ripgrep error (exit code: ${exitCode}): ${error.message}`)
          }
          resolve([])
        } else {
          resolve(stdout.trim().split('\n').filter(line => line.length > 0))
        }
      },
    )
  })
}

/**
 * 获取 ripgrep 可执行文件路径（带缓存）
 * 优先使用系统 PATH，否则使用 @vscode/ripgrep 内置版本
 */
const getRipgrepPath = memoize((): string => {
  const { cmd } = findActualExecutable('rg', [])
  if (cmd !== 'rg') {
    return cmd
  }

  const binaryName = exeName('rg')

  // 通过 require.resolve 定位模块路径
  try {
    const modulePath = require.resolve('@vscode/ripgrep')
    const binaryPath = path.join(path.dirname(modulePath), '..', 'bin', binaryName)
    if (fs.existsSync(binaryPath)) {
      return binaryPath
    }
  } catch {
    // require.resolve 失败，继续尝试其他方法
  }

  // 从当前文件向上查找 node_modules
  for (const rel of ['../node_modules', '../../node_modules']) {
    const candidate = path.resolve(__dirname, rel, '@vscode/ripgrep/bin', binaryName)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  throw new Error(`@vscode/ripgrep binary not found: ${binaryName}`)
})


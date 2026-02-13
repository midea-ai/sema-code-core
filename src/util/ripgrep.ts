import { findActualExecutable } from 'spawn-rx'
import { memoize } from 'lodash-es'
import { logError } from './log'
import { execFileNoThrow } from './exec'
import { execFile } from 'child_process'
import * as path from 'path'
import * as fs from 'fs'

const useBuiltinRipgrep = !!process.env.USE_BUILTIN_RIPGREP

export async function ripGrep(
  args: string[],
  target: string,
  abortSignal: AbortSignal,
): Promise<string[]> {
  await codesignRipgrepIfNecessary()
  const rg = ripgrepPath()

  // Windows 环境下，转换 Unix 风格的驱动器路径
  let processedTarget = target
  if (process.platform === 'win32') {
    const unixDrivePattern = /^\/([a-z])\//i
    const match = unixDrivePattern.exec(target)

    if (match) {
      const driveLetter = match[1].toUpperCase()
      const rest = target.slice(3) // 去掉 /d/ 部分
      processedTarget = `${driveLetter}:\\${rest.replace(/\//g, '\\')}`
    }
  }

  // NB: When running interactively, ripgrep does not require a path as its last
  // argument, but when run non-interactively, it will hang unless a path or file
  // pattern is provided
  return new Promise((resolve, reject) => {
    execFile(
      rg,
      [...args, processedTarget],
      {
        maxBuffer: 1_000_000,
        signal: abortSignal,
        timeout: 10_000,
      },
      (error, stdout) => {
        if (error) {
          // Exit code 1 from ripgrep means "no matches found" - this is normal
          const exitCode = typeof error.code === 'number' ? error.code :
                          typeof error.code === 'string' ? parseInt(error.code, 10) :
                          undefined

          if (exitCode === 1) {
            // No matches found is normal, return empty array
            resolve([])
          } else {
            // Log other errors for debugging
            logError(`ripgrep error (code: ${exitCode}): ${error.message}`)
            resolve([]) // Still resolve with empty array to avoid breaking the flow
          }
        } else {
          resolve(stdout.trim().split('\n').filter(Boolean))
        }
      },
    )
  })
}

let alreadyDoneSignCheck = false
async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow(
      'codesign',
      ['-vv', '-d', ripgrepPath()],
      undefined,
      undefined,
      false,
    )
  ).stdout.split('\n')

  // If we find "linker-signed", it means it's only linker-signed and needs proper signing
  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    // Already properly signed or no signing info found
    return
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      ripgrepPath(),
    ])

    if (signResult.code !== 0) {
      logError(
        `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
      )
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      ripgrepPath(),
    ])

    if (quarantineResult.code !== 0) {
      logError(
        `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
      )
    }
  } catch (e) {
    logError(e)
  }
}

// 运行时动态获取 @vscode/ripgrep 的路径，避免打包时路径被固化
function getVscodeRipgrepPath(): string {
  // 关键：process.platform 在运行时求值，而不是打包时
  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg'

  try {
    // 方法1：通过 require.resolve 找到模块位置
    const ripgrepModulePath = require.resolve('@vscode/ripgrep')
    const moduleBinPath = path.join(path.dirname(ripgrepModulePath), '..', 'bin', rgName)
    if (fs.existsSync(moduleBinPath)) {
      return moduleBinPath
    }
  } catch {
    // require.resolve 失败，尝试其他方法
  }

  // 方法2：相对于当前模块的路径
  const relativePath = path.resolve(__dirname, '../node_modules/@vscode/ripgrep/bin', rgName)
  if (fs.existsSync(relativePath)) {
    return relativePath
  }

  // 方法3：相对于 __dirname 向上查找
  const parentPath = path.resolve(__dirname, '../../node_modules/@vscode/ripgrep/bin', rgName)
  if (fs.existsSync(parentPath)) {
    return parentPath
  }

  throw new Error(`@vscode/ripgrep binary not found: tried multiple paths for ${rgName}`)
}

const ripgrepPath = memoize(() => {
  const { cmd } = findActualExecutable('rg', [])

  if (cmd !== 'rg' && !useBuiltinRipgrep) {
    // NB: If we're able to find ripgrep in $PATH, cmd will be an absolute
    // path rather than just returning 'rg'
    return cmd
  } else {
    // Use @vscode/ripgrep which auto-downloads platform-specific binary
    // 运行时动态计算路径，避免打包时路径被固化的问题
    try {
      const rgPath = getVscodeRipgrepPath()
      return rgPath
    } catch (error) {
      logError(`Error finding ripgrep: ${error}`)
      throw error
    }
  }
})


// NB: We do something tricky here. We know that ripgrep processes common
// ignore files for us, so we just ripgrep for any character, which matches
// all non-empty files
export async function listAllContentFiles(
  path: string,
  abortSignal: AbortSignal,
  limit: number,
): Promise<string[]> {
  try {
    return (await ripGrep(['-l', '.'], path, abortSignal)).slice(0, limit)
  } catch (e) {
    logError(e)
    return []
  }
}
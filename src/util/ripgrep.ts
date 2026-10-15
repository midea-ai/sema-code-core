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

  return new Promise((resolve, reject) => {
    execFile(
      ripgrepExecutable,
      [...searchArgs, nativeSearchPath],
      {
        maxBuffer: 512_000,
        ...(abortSignal && { signal: abortSignal }),
        timeout: 8_000,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.trim().split('\n').filter(line => line.length > 0))
          return
        }
        const code = error.code
        // 退出码 1 表示未找到匹配，属于正常情况
        if (code === 1) {
          resolve([])
          return
        }
        // 超时 / 中断：按无结果处理
        if (error.killed || abortSignal?.aborted) {
          resolve([])
          return
        }
        // 进程起不来（ENOENT / EACCES 等）：二进制缺失或不可执行，必须让调用方知道，不能当作"无匹配"
        if (typeof code === 'string') {
          reject(new Error(`ripgrep failed to start (${code}): ${ripgrepExecutable}`))
          return
        }
        // 退出码 2：参数或正则错误，把 rg 的提示（多行压成一行）带给调用方
        const detail = (stderr || error.message)
          .split('\n').map(l => l.trim()).filter(Boolean).join(' ').slice(0, 300)
        logError(`ripgrep error (exit code: ${code}): ${detail}`)
        reject(new Error(`ripgrep error: ${detail}`))
      },
    )
  })
}

/**
 * 获取 ripgrep 可执行文件路径（带缓存）
 * 查找顺序：系统 PATH → @vscode/ripgrep 1.18+ 的平台子包 → 旧版 @vscode/ripgrep/bin
 */
const getRipgrepPath = memoize((): string => {
  const { cmd } = findActualExecutable('rg', [])
  if (cmd !== 'rg') {
    return cmd
  }

  const binaryName = exeName('rg')

  // @vscode/ripgrep 1.18+：主包不再带二进制，拆到按平台的 optionalDependencies 子包
  // （@vscode/ripgrep-<platform>-<arch>/bin/rg），npm 只装当前平台那一份
  const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`
  try {
    return require.resolve(`${platformPkg}/bin/${binaryName}`)
  } catch {
    // 子包不存在，继续找旧布局
  }

  // @vscode/ripgrep 1.17 及以前（postinstall 下载到主包 bin/），以及 desktop afterPack 拷回该位置的产物
  try {
    const modulePath = require.resolve('@vscode/ripgrep/package.json')
    const binaryPath = path.join(path.dirname(modulePath), 'bin', binaryName)
    if (fs.existsSync(binaryPath)) {
      return binaryPath
    }
  } catch {
    // require.resolve 失败，继续尝试其他方法
  }

  // 从当前文件向上查找 node_modules（两种布局都看）
  for (const rel of ['../node_modules', '../../node_modules']) {
    for (const pkgDir of [platformPkg, '@vscode/ripgrep']) {
      const candidate = path.resolve(__dirname, rel, pkgDir, 'bin', binaryName)
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }

  throw new Error(
    `ripgrep binary not found: no "rg" in PATH and neither ${platformPkg} nor @vscode/ripgrep/bin/${binaryName} is installed`,
  )
})


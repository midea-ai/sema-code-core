import os from 'os'
import { getIsGit } from './git'
import { readInitialCwd } from './cwd'
import { getShellRuntimeInfo } from './shell'
import { IS_WIN } from './platform'

let cached: string | undefined

export async function getEnv(): Promise<string> {
  if (cached) return cached

  const cwd = readInitialCwd()
  const isGitRepo = await getIsGit()

  const lines = [
    `Working dir: ${cwd}`,
    `Is a Git repo: ${isGitRepo ? 'Yes' : 'No'}`,
    `Platform: ${process.platform}`,
    `OS: ${os.type()} ${os.release()}`,
  ]

  if (IS_WIN) {
    const shell = getShellRuntimeInfo()
    lines.push(`Shell type: ${shell?.type ?? 'unknown'}`)
    if (shell?.bin) lines.push(`Shell binary: ${shell.bin}`)
  }

  cached = lines.join('\n')

  return cached
}

import { execFileSafely } from './file'
import { logError } from './log'
import { readInitialCwd } from './cwd'

function gitStdout(args: string[]) {
  return execFileSafely('git', args, undefined, undefined, true, readInitialCwd()).then(({ stdout, code }) => {
    if (code !== 0) return ''
    return stdout.trim()
  })
}

let isGitInflight: Promise<boolean> | null = null

/** 并发的调用合并为一个 git 进程（建会话时 env 与 git 状态同时要它）；结束即清，不跨调用缓存结果 */
export function getIsGit(): Promise<boolean> {
  if (!isGitInflight) {
    isGitInflight = execFileSafely('git', ['rev-parse', '--is-inside-work-tree'], undefined, undefined, true, readInitialCwd())
      .then(({ code }) => code === 0)
      .finally(() => { isGitInflight = null })
  }
  return isGitInflight
}

export async function getGitStatus(): Promise<string | null> {
  try {
    // 五条命令一轮并发，不先串行判仓库再查状态（Windows 上每个 git 进程都要上百毫秒）；不是仓库时其余结果直接丢弃
    const [isGit, branch, mainBranch, status, log] = await Promise.all([
      getIsGit(),
      gitStdout(['branch', '--show-current']),
      gitStdout(['rev-parse', '--abbrev-ref', 'origin/HEAD']).then(s => s.replace('origin/', '')),
      gitStdout(['status', '--short']),
      gitStdout(['log', '--oneline', '-n', '5']),
    ])
    if (!isGit) return null

    const statusParts = status.split('\n')
    const truncatedStatus = statusParts.length > 200
      ? statusParts.slice(0, 200).join('\n') + '\n... (truncated at 200 lines, run "git status" for full output)'
      : status

    const lines = [
      'Git status snapshot (read-only, will not update during the conversation):',
      `Current branch: ${branch || '(unknown)'}`,
    ]
    if (mainBranch) lines.push(`Main branch: ${mainBranch}`)
    lines.push('', 'Status:', truncatedStatus || '(clean)')
    if (log) lines.push('', 'Recent commits:', log)
    return lines.join('\n')
  } catch (error) {
    logError(error)
    return null
  }
}

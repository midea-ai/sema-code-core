import { execFileSafely } from './file'
import { logError } from './log'
import { readInitialCwd } from './cwd'

function gitStdout(args: string[]) {
  return execFileSafely('git', args, undefined, undefined, true, readInitialCwd()).then(({ stdout, code }) => {
    if (code !== 0) return ''
    return stdout.trim()
  })
}

export async function getIsGit(): Promise<boolean> {
  const { code } = await execFileSafely('git', ['rev-parse', '--is-inside-work-tree'], undefined, undefined, true, readInitialCwd())
  return code === 0
}

export async function getGitStatus(): Promise<string | null> {
  if (!(await getIsGit())) {
    return null
  }

  try {
    const [branch, mainBranch, status, log] = await Promise.all([
      gitStdout(['branch', '--show-current']),
      gitStdout(['rev-parse', '--abbrev-ref', 'origin/HEAD']).then(s => s.replace('origin/', '')),
      gitStdout(['status', '--short']),
      gitStdout(['log', '--oneline', '-n', '5']),
    ])

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
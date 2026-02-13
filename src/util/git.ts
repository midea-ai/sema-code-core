import { memoize } from 'lodash-es'
import { execFileNoThrow } from './exec'
import { logError } from './log'
import { getOriginalCwd } from './cwd'

export const getIsGit = memoize(async (): Promise<boolean> => {
  const { code } = await execFileNoThrow('git', [
    'rev-parse',
    '--is-inside-work-tree',
  ], undefined, undefined, true, getOriginalCwd())
  return code === 0
})

export const getGitStatus = memoize(async (): Promise<string | null> => {
  if (!(await getIsGit())) {
    return null
  }

  try {
    const [branch, mainBranch, status, log, authorLog] = await Promise.all([
      execFileNoThrow(
        'git',
        ['branch', '--show-current'],
        undefined,
        undefined,
        false,
        getOriginalCwd(),
      ).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(
        'git',
        ['rev-parse', '--abbrev-ref', 'origin/HEAD'],
        undefined,
        undefined,
        false,
        getOriginalCwd(),
      ).then(({ stdout }) => stdout.replace('origin/', '').trim()),
      execFileNoThrow(
        'git',
        ['status', '--short'],
        undefined,
        undefined,
        false,
        getOriginalCwd(),
      ).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(
        'git',
        ['log', '--oneline', '-n', '5'],
        undefined,
        undefined,
        false,
        getOriginalCwd(),
      ).then(({ stdout }) => stdout.trim()),
      execFileNoThrow(
        'git',
        [
          'log',
          '--oneline',
          '-n',
          '5',
          '--author',
          (await getGitEmail()) || '',
        ],
        undefined,
        undefined,
        false,
        getOriginalCwd(),
      ).then(({ stdout }) => stdout.trim()),
    ])
    // Check if status has more than 200 lines
    const statusLines = status.split('\n').length
    const truncatedStatus =
      statusLines > 200
        ? status.split('\n').slice(0, 200).join('\n') +
          '\n... (truncated because there are more than 200 lines. If you need more information, run "git status" using BashTool)'
        : status

    return `This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.\nCurrent branch: ${branch}\n\nMain branch (you will usually use this for PRs): ${mainBranch}\n\nStatus:\n${truncatedStatus || '(clean)'}\n\nRecent commits:\n${log}\n\n}`
  } catch (error) {
    logError(error)
    return null
  }
})

export const getGitEmail = memoize(async (): Promise<string | undefined> => {
  const result = await execFileNoThrow('git', ['config', 'user.email'], undefined, undefined, true, getOriginalCwd())
  if (result.code !== 0) {
    logError(`Failed to get git email: ${result.stdout} ${result.stderr}`)
    return undefined
  }
  return result.stdout.trim() || undefined
})
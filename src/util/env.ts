
import { memoize } from 'lodash-es'
import os from 'os'
import { getIsGit } from './git'
import { getOriginalCwd } from './cwd'

export const env = {
  platform:
    process.platform === 'win32'
      ? 'windows'
      : process.platform === 'darwin'
        ? 'macos'
        : 'linux',
}

export const getEnv = memoize(async (): Promise<string> => {
  const cwd = getOriginalCwd()
  const isGitRepo = await getIsGit()
  const osVersion = os.release()
  const today = new Date().toISOString().split('T')[0]

  return `Working directory: ${cwd}
Is directory a git repo: ${isGitRepo ? 'Yes' : 'No'}
Platform: ${process.platform}
OS Version: ${os.type()} ${osVersion}
Today's date: ${today}`
})

import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { canonicalizeFilePath } from './file'
import { readInitialCwd } from './cwd'
import { getModelConfigFilePath, getSemaRootDir } from './savePath'
import { IS_MAC, IS_WIN, normalizeCmpPath } from './platform'

/**
 * 文件读取位置分类，供 PermissionManager 裁决：
 *  - trusted：项目内、系统临时目录、SEMA_ROOT 受信内容目录 → 静默放行
 *  - home：当前用户可自由支配的位置（用户目录内；Windows 下还含系统目录之外的本地盘路径）
 *          → Ask 询问并可按父目录授权，AutoEdit / AutoRun 自动放行
 *  - restricted：敏感凭据文件、其他用户目录、系统目录等其余位置 → 各档位均转人工，只许单次同意
 */
export type ReadPathClass = 'trusted' | 'home' | 'restricted'

// 系统临时目录：这些目录树下的文件视为临时文件。
// tmpdir() 已涵盖 $TMPDIR/$TEMP/$TMP；/var/folders 覆盖 macOS 临时/缓存区。
// POSIX 字面路径仅在非 Windows 生效：Windows 上 '/tmp' 会被解析成当前盘的 \tmp（如 D:\tmp）而被误信任。
export const TEMP_BASE_PATHS = [
  tmpdir(),
  ...(IS_WIN ? [] : ['/tmp', '/var/tmp']),
  ...(IS_MAC ? ['/var/folders'] : []),
]

// SEMA_ROOT 下的受信内容子目录：全局 skill/命令/agent/插件/hooks 均为用户自行安装的内容，读取静默放行。
// 注意：豁免仅覆盖读取，hooks 脚本会被执行，写入仍走文件编辑权限转人工。
const TRUSTED_SEMA_SUBDIRS = ['skills', 'commands', 'agents', 'plugins', 'hooks']

// 敏感凭据（相对用户目录，三平台同名）：只收「内容即明文凭据」的条目，刻意保持精简。
// _netrc 为 .netrc 的 Windows 写法。
const SENSITIVE_HOME_ENTRIES = ['.ssh', '.aws', '.npmrc', '.netrc', '_netrc', '.git-credentials']

function isInside(child: string, root: string): boolean {
  const rel = relative(normalizeCmpPath(root), normalizeCmpPath(child))
  if (!rel) return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * 解析符号链接得到真实路径（macOS 的 /tmp → /private/tmp、Windows 的 8.3 短文件名等均在此归一）。
 * 路径不存在时解析最近一层存在的上级目录，再拼回剩余部分；完全无法解析则原样返回。
 */
function resolveRealPath(absPath: string): string {
  let current = absPath
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length ? join(real, ...tail) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return absPath
      tail.unshift(basename(current))
      current = parent
    }
  }
}

function isInsideAnyReal(real: string, roots: string[]): boolean {
  return roots.some(root => isInside(real, resolveRealPath(root)))
}

// 敏感判定同时看字面路径与真实路径，任一命中即敏感（取严）
function isSensitivePath(abs: string, real: string): boolean {
  const roots = [
    ...SENSITIVE_HOME_ENTRIES.map(entry => join(homedir(), entry)),
    getModelConfigFilePath(),
    join(getSemaRootDir(), '.mcp.json'),
  ]
  return roots.some(root => isInside(abs, root)) || isInsideAnyReal(real, roots)
}

// Windows 下明确不属于当前用户的位置：系统目录、其他用户目录、网络路径。
// 目录取自环境变量而非写死盘符；其余本地盘路径（D:\work、C:\work 等）视为用户可自由支配。
function isWindowsRestricted(real: string): boolean {
  if (/^\\\\[^?.]/.test(real)) return true
  const env = process.env
  const systemRoots = [
    env.SystemRoot,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramW6432,
    env.ProgramData,
    dirname(homedir()),
  ].filter((p): p is string => !!p)
  return isInsideAnyReal(real, systemRoots)
}

export function classifyReadPath(filePath: string): ReadPathClass {
  const abs = canonicalizeFilePath(filePath)
  const real = resolveRealPath(abs)

  // 敏感判定排最前：在用户目录下启动（项目根 = ~）或授权过 ~ 时，凭据文件也不会被放行
  if (isSensitivePath(abs, real)) return 'restricted'

  // 项目与临时目录只认真实路径：项目内指向外部的符号链接按其真实目标归类
  if (isInsideAnyReal(real, [readInitialCwd(), ...TEMP_BASE_PATHS])) return 'trusted'

  // 受信 SEMA 内容由用户自行安装，链接进来的 skill/插件目录同样受信，故字面与真实路径任一命中即可
  const trustedSemaDirs = TRUSTED_SEMA_SUBDIRS.map(sub => join(getSemaRootDir(), sub))
  if (trustedSemaDirs.some(dir => isInside(abs, dir)) || isInsideAnyReal(real, trustedSemaDirs)) return 'trusted'

  if (isInsideAnyReal(real, [homedir()])) return 'home'

  if (IS_WIN) return isWindowsRestricted(real) ? 'restricted' : 'home'
  return 'restricted'
}

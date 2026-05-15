import * as os from 'os'
import * as path from 'path'

// ── 平台标识 ─────────────────────────────────────────────────────────────────
export const IS_WIN   = process.platform === 'win32'
export const IS_MAC   = process.platform === 'darwin'
export const IS_LINUX = !IS_WIN && !IS_MAC

// ── 路径转换 ─────────────────────────────────────────────────────────────────

/**
 * 将 Unix 风格的驱动器路径转换为 Windows 原生路径
 * /c/Users/foo → C:\Users\foo
 * 非 Windows 平台直接返回原路径
 */
export function unixDriveToNative(p: string): string {
  if (!IS_WIN) return p
  const match = /^\/([a-zA-Z])\/(.*)/.exec(p)
  if (!match) return p
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`
}

/**
 * 将 Windows 原生路径转换为 bash 可识别的路径
 * msys:  C:\foo\bar → /c/foo/bar
 * wsl:   C:\foo\bar → /mnt/c/foo/bar
 * posix: 不做转换
 */
export function nativeToShellPath(p: string, type: 'posix' | 'msys' | 'wsl'): string {
  if (p.startsWith('/')) return p
  if (type === 'posix') return p
  const normalized = p.replace(/\\/g, '/')
  const driveMatch = /^[A-Za-z]:/.exec(normalized)
  if (driveMatch) {
    const drive = normalized[0].toLowerCase()
    const rest = normalized.slice(2)
    const restWithSlash = rest.startsWith('/') ? rest : `/${rest}`
    return type === 'msys' ? `/${drive}${restWithSlash}` : `/mnt/${drive}${restWithSlash}`
  }
  return normalized
}

/**
 * 展开 ~ 开头的路径为绝对路径，非 ~ 路径调用 path.resolve
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}

/**
 * Windows 路径比较规范化（Windows 路径不区分大小写）
 */
export function normalizeCmpPath(p: string): string {
  const resolved = path.resolve(p)
  return IS_WIN ? resolved.toLowerCase() : resolved
}

/**
 * 平台相关的可执行文件名（Windows 加 .exe 后缀）
 */
export function exeName(name: string): string {
  return IS_WIN ? `${name}.exe` : name
}

// ── PATH 分割 ─────────────────────────────────────────────────────────────────

/**
 * 跨平台 PATH 环境变量分割
 * POSIX 使用 `:` 分隔，Windows 使用 `;`（需处理驱动器字母中的 `:`）
 */
export function splitPathEntries(pathEnv: string): string[] {
  if (!pathEnv) return []

  if (!IS_WIN) {
    return pathEnv
      .split(':')
      .map(s => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
  }

  // Windows：主要使用 `;`，但要避免把驱动器字母后的 `:` 当分隔符
  const entries: string[] = []
  let current = ''

  const pushCurrent = () => {
    const cleaned = current.trim().replace(/^"|"$/g, '')
    if (cleaned) entries.push(cleaned)
    current = ''
  }

  for (let i = 0; i < pathEnv.length; i++) {
    const ch = pathEnv[i]
    if (ch === ';') {
      pushCurrent()
      continue
    }
    if (ch === ':') {
      const isDriveLetterPrefix = current.length === 1 && /[A-Za-z]/.test(current)
      if (!isDriveLetterPrefix) {
        pushCurrent()
        continue
      }
    }
    current += ch
  }
  pushCurrent()

  return entries
}

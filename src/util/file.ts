import {
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
  existsSync,
  readdirSync,
} from 'fs'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { logError } from './log'
import {
  isAbsolute,
  normalize,
  resolve,
  relative,
  sep,
  basename,
  dirname,
  extname,
} from 'path'
import { glob as globLib } from 'glob'
import { cwd } from 'process'
import { LRUCache } from 'lru-cache'
import { readInitialCwd } from './cwd'
import { IS_WIN, unixDriveToNative } from './platform'

export type LineEndingKind = 'CRLF' | 'LF'

export async function globFiles(
  filePattern: string,
  cwd: string,
  { limit, offset }: { limit: number; offset: number },
  abortSignal: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  const paths = await globLib([filePattern], {
    cwd: unixDriveToNative(cwd),
    nocase: true,
    nodir: true,
    signal: abortSignal,
    stat: true,
    withFileTypes: true,
  })
  const sortedPaths = paths.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
  const truncated = sortedPaths.length > offset + limit
  return {
    files: sortedPaths
      .slice(offset, offset + limit)
      .map(path => path.fullpath()),
    truncated,
  }
}

/**
 * 判断目标路径是否在工作目录内部
 */
export function isInDirectory(
  relativePath: string,
  relativeCwd: string,
): boolean {
  // 当前目录直接返回 true
  if (relativePath === '.') {
    return true
  }

  // 拒绝家目录路径（以 ~ 开头）
  if (relativePath.startsWith('~')) {
    return false
  }

  // 拒绝包含空字符的路径（防注入攻击）
  if (relativePath.includes('\0') || relativeCwd.includes('\0')) {
    return false
  }

  // 标准化路径，解析 '..' 和 '.' 段，并添加尾部斜杠
  let normalizedPath = normalize(relativePath)
  let normalizedCwd = normalize(relativeCwd)

  normalizedPath = normalizedPath.endsWith(sep)
    ? normalizedPath
    : normalizedPath + sep
  normalizedCwd = normalizedCwd.endsWith(sep)
    ? normalizedCwd
    : normalizedCwd + sep

  // 拼接为绝对路径形式以便比较
  const fullPath = resolve(cwd(), normalizedCwd, normalizedPath)
  const fullCwd = resolve(cwd(), normalizedCwd)

  // 使用 path.relative 判断子目录关系（Windows 上大小写不敏感）
  const rel = relative(fullCwd, fullPath)
  if (!rel || rel === '') return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  return true
}

/**
 * 读取文本文件内容，自动标准化换行符为 LF
 */
export function readTextContent(
  filePath: string,
  offset = 0,
  maxLines?: number,
): { content: string; lineCount: number; totalLines: number } {
  const enc = inferFileEncoding(filePath)
  const raw = readFileSync(filePath, enc)

  // 标准化为 LF
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n')

  // 处理分页读取
  const toReturn =
    maxLines !== undefined && lines.length - offset > maxLines
      ? lines.slice(offset, offset + maxLines)
      : lines.slice(offset)

  return {
    content: toReturn.join('\n'),
    lineCount: toReturn.length,
    totalLines: lines.length,
  }
}

/**
 * 写入文本文件，按指定换行符格式输出
 */
export function writeTextFile(
  filePath: string,
  content: string,
  encoding: BufferEncoding,
  endings: LineEndingKind,
): void {
  // 仅在需要 CRLF 且内容包含 LF 时进行转换
  const finalContent = endings === 'CRLF' && content.includes('\n')
    ? content.replace(/\r?\n/g, '\r\n')
    : content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  writeFileSync(filePath, finalContent, { encoding, flush: true })
}


const FILE_HEADER_SIZE = 4096

/**
 * 读取文件头部字节（用于编码识别和换行符探测）
 */
function readFileHeader(filePath: string): Buffer {
  const buf = Buffer.alloc(FILE_HEADER_SIZE)
  const fd = openSync(filePath, 'r')
  const bytesRead = readSync(fd, buf, 0, FILE_HEADER_SIZE, 0)
  closeSync(fd)
  return buf.subarray(0, bytesRead)
}

/**
 * 文件编码识别结果缓存
 */
const fileEncodingCache = new LRUCache<string, BufferEncoding>({
  ttl: 5 * 60 * 1000,
  ttlAutopurge: false,
  max: 1000,
})

const BINARY_FILE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.tif', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.exe', '.dll', '.so', '.dylib',
])

function isBinaryFile(filePath: string): boolean {
  return BINARY_FILE_EXTS.has(extname(filePath).toLowerCase())
}

export function inferFileEncoding(filePath: string): BufferEncoding {
  const absolutePath = resolve(filePath)
  if (isBinaryFile(absolutePath)) return 'utf8'
  const cached = fileEncodingCache.get(absolutePath)
  if (cached) return cached
  try {
    const header = readFileHeader(absolutePath)
    let result: BufferEncoding = 'utf8'
    if (header.length >= 2 && header[0] === 0xff && header[1] === 0xfe) {
      result = 'utf16le'
    } else if (header.length >= 3 && header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf) {
      result = 'utf8'
    } else {
      result = header.toString('utf8').length > 0 ? 'utf8' : 'ascii'
    }
    fileEncodingCache.set(absolutePath, result)
    return result
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logError(`文件编码识别失败 ${filePath}: ${error}`)
    }
    return 'utf8'
  }
}

export function inferLineEndings(filePath: string): LineEndingKind {
  if (isBinaryFile(filePath)) return 'LF'
  try {
    const header = readFileHeader(resolve(filePath)).toString('utf8')
    const crlfCount = (header.match(/\r\n/g) ?? []).length
    const lfCount = (header.match(/(?<!\r)\n/g) ?? []).length
    return crlfCount > lfCount ? 'CRLF' : 'LF'
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logError(`文件换行符探测失败 ${filePath}: ${err}`)
    }
    return 'LF'
  }
}

const NARROW_NO_BREAK_SPACE = String.fromCharCode(8239)

export function canonicalizeFilePath(filePath: string): string {
  const processedPath = unixDriveToNative(filePath)

  let absoluteFilePath = isAbsolute(processedPath)
    ? processedPath
    : resolve(readInitialCwd(), processedPath)

  // MacOS 截图文件名中的半角空格替换为窄不换行空格
  absoluteFilePath = absoluteFilePath.replace(
    / (AM|PM)\.png$/,
    `${NARROW_NO_BREAK_SPACE}$1.png`,
  )

  // 强制标准化路径分隔符，确保 Windows 上统一使用反斜杠
  const normalized = normalize(absoluteFilePath)
  return IS_WIN ? normalized.replace(/\//g, '\\') : normalized
}

/**
 * 在同目录下查找同名但不同扩展名的文件
 */
export function findFileWithDifferentExt(filePath: string): string | undefined {
  try {
    const dir = dirname(filePath)
    const originalExt = extname(filePath)
    const baseName = basename(filePath, originalExt)

    if (!existsSync(dir)) {
      return undefined
    }

    for (const file of readdirSync(dir)) {
      const fileExt = extname(file)
      if (fileExt && fileExt !== originalExt && basename(file, fileExt) === baseName) {
        return file
      }
    }

    return undefined
  } catch (error) {
    logError(`查找同名不同扩展名文件失败 ${filePath}: ${error}`)
    return undefined
  }
}

/**
 * 为文本内容添加行号（cat -n 风格）
 */
export function formatWithLineNumbers({
  content,
  startLine,
}: {
  content: string
  startLine: number
}): string {
  if (!content) { return '' }

  return content
    .split('\n')
    .map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`)
    .join('\n')
}

/**
 * 在 JSON.stringify(data, null, 2) 生成的文本中，查找包含 match 的对象块行范围。
 *
 * 算法：找到 match 所在行，往回找最近的含 '{' 的行作为对象起始，
 * 记录该行缩进，然后往下找同缩进的 '}' 行作为对象结束。
 *
 */
export function findJsonObjectLineRange(json: string, match: string): [number, number] | undefined {
  const lines = json.split('\n')

  // 1. 找 match 所在行
  const matchIdx = lines.findIndex(l => l.includes(match))
  if (matchIdx === -1) return undefined

  // 2. 从 match 行往回找最近的含 '{' 的行
  let startIdx = -1
  for (let j = matchIdx; j >= 0; j--) {
    if (lines[j].includes('{')) {
      startIdx = j
      break
    }
  }
  if (startIdx === -1) return undefined

  // 3. 记录起始行缩进（'{' 前的空格数）
  const indent = lines[startIdx].search(/\S/)

  // 4. 往下找同缩进级别的 '}' 行
  for (let i = startIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trimStart()
    if (trimmed.startsWith('}') && lines[i].search(/\S/) === indent) {
      return [startIdx + 1, i + 1]
    }
  }

  return undefined
}

/**
 * 获取相对于初始工作目录的显示路径，超出范围则返回绝对路径
 */
export function getDisplayPath(filePath: string): string {
  const rel = relative(readInitialCwd(), filePath)
  return rel.startsWith('..') ? filePath : rel
}

/**
 * 获取文件路径（从工具输入中）
 */
export function getFilePath(input: { [key: string]: unknown }): string | undefined {
  return (input as any).file_path || (input as any).notebook_path
}

// ==================== 安全执行 ====================

const execFileAsync = promisify(execFileCb)

const DEFAULT_EXEC_TIMEOUT = 10 * 60 * 1000

interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

// 执行但从不抛出
export async function execFileSafely(
  file: string,
  args: string[],
  abortSignal?: AbortSignal,
  timeout = DEFAULT_EXEC_TIMEOUT,
  preserveOutputOnError = true,
  cwd?: string,
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      maxBuffer: 1_000_000,
      signal: abortSignal,
      timeout,
      cwd: cwd || readInitialCwd(),
    })
    return { stdout, stderr, code: 0 }
  } catch (error: any) {
    if (!preserveOutputOnError) {
      logError(error)
    }
    if (preserveOutputOnError) {
      return {
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
        code: typeof error.code === 'number' ? error.code : 1,
      }
    }
    return { stdout: '', stderr: '', code: 1 }
  }
}

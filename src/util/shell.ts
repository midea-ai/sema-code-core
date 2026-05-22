import * as fs from 'fs'
import { existsSync } from 'fs'
import shellquote from 'shell-quote'
import { spawn, execSync, type ChildProcess } from 'child_process'
import { isAbsolute, resolve, join } from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import * as iconv from 'iconv-lite'
import { logError, logInfo, logWarn } from './log'
import { IS_WIN, nativeToShellPath, splitPathEntries } from './platform'
import { readInitialCwd } from './cwd'

// 临时文件前缀
const TEMPFILE_PREFIX = join(os.tmpdir(), 'sema-')
// 默认超时时间（2分钟）
const DEFAULT_SHELL_TIMEOUT = 120 * 1000
// SIGTERM信号的标准退出码
const SIGTERM_CODE = 143
// 流式输出检查间隔（ms）
const CHUNK_CHECK_INTERVAL = 2000
// 文件后缀定义
const FILE_SUFFIXES = {
  STATUS: '-status',    // 状态文件后缀
  STDOUT: '-stdout',    // 标准输出文件后缀
  STDERR: '-stderr',    // 标准错误文件后缀
  CWD: '-cwd',          // 当前工作目录文件后缀
}

// 执行结果类型定义
type ShellExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
}

// 超时接管上下文（旧 shell 的临时文件路径和进程引用）
export type TimeoutTransferContext = {
  stdoutFile: string
  stderrFile: string
  statusFile: string
  shellProcess: ChildProcess
  partialOutput: string
}

export function humanizeDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const min = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${min}min${rem}s` : `${min}min`
}

/**
 * 智能解码 Buffer 为字符串（仅 Windows 需要）
 * 优先尝试 UTF-8，如果检测到乱码则尝试 GBK
 */
function smartDecode(buffer: Buffer): string {
  if (buffer.length === 0) return ''

  // 非 Windows 系统直接使用 UTF-8
  if (!IS_WIN) {
    return buffer.toString('utf8')
  }

  // Windows: 先尝试 UTF-8
  const utf8Text = buffer.toString('utf8')

  // 检测 UTF-8 解码是否产生了替换字符（�）
  // 这是 UTF-8 解码失败的标志
  const hasReplacementChar = utf8Text.includes('\uFFFD')

  // 如果没有替换字符，说明 UTF-8 解码成功
  if (!hasReplacementChar) {
    return utf8Text
  }

  // UTF-8 失败，尝试 GBK
  try {
    if (iconv.encodingExists('gbk')) {
      const gbkText = iconv.decode(buffer, 'gbk')
      logInfo('检测到非 UTF-8 输出，使用 GBK 解码')
      return gbkText
    }
  } catch (error) {
    logWarn(`GBK 解码失败: ${error}`)
  }

  // 兜底：返回 UTF-8 结果
  return utf8Text
}

// Cygwin 运行时在进程被强制终止时输出的内部噪音行
// 例：`0 [main] bash (1234) child_copy: ...` 或 `*** fatal error in forked process`
const CYGWIN_NOISE_RE = /^(?:\d+\s+\[main\]\s+\S+.*|.*\*{3}\s+fatal error in forked process.*)/

function filterCygwinNoise(text: string): string {
  if (!IS_WIN) return text
  return text
    .split('\n')
    .filter(line => !CYGWIN_NOISE_RE.test(line))
    .join('\n')
}

// 队列中的命令类型定义
type PendingShellCommand = {
  command: string
  abortSignal?: AbortSignal
  timeout?: number
  onChunk?: (stdout: string, stderr: string) => void
  onTimeout?: (ctx: TimeoutTransferContext) => void
  resolve: (result: ShellExecResult) => void
  reject: (error: Error) => void
}

// 检测到的Shell信息类型
export type ShellType = 'posix' | 'msys' | 'wsl' | 'powershell' | 'cmd'

export type DetectedShell = {
  bin: string           // Shell二进制文件路径
  args: string[]        // 启动参数
  type: ShellType       // Shell类型
}

// 为Bash转义字符串
function quoteForBash(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`
}

// 测试 bash 是否可用（结果自动缓存）
const testBashAvailability = (() => {
  const cache = new Map<string, boolean>()
  return (bashPath: string, type: 'msys' | 'wsl' = 'msys'): boolean => {
    const cacheKey = `${bashPath}:${type}`
    const cached = cache.get(cacheKey)
    if (cached !== undefined) return cached

    let ok = false
    try {
      logInfo(`测试 bash 可用性: ${bashPath}`)
      const output = execSync(`"${bashPath}" -c "echo SEMA_TEST_OK"`, {
        stdio: 'pipe', timeout: 3000, encoding: 'utf8',
      }).toString().trim()
      ok = output.includes('SEMA_TEST_OK')
      if (ok) logInfo(`bash 测试通过: ${bashPath}`)
      else logWarn(`bash 测试失败，输出不符合预期: ${bashPath}, 输出: ${output}`)
    } catch (error) {
      logWarn(`bash 测试失败: ${bashPath}, 错误: ${error}`)
    }
    cache.set(cacheKey, ok)
    return ok
  }
})()

// 尝试使用指定路径的 bash，存在且测试通过返回 true
function tryBash(candidate: string, type: 'msys' | 'wsl' = 'msys'): boolean {
  return existsSync(candidate) && testBashAvailability(candidate, type)
}

// 检测可用的Shell（结果缓存，避免重复探测）
let detectedShellCache: DetectedShell | null = null

function resolveShellBinary(): DetectedShell {
  return (detectedShellCache ??= detectShellImpl())
}

export function getShellRuntimeInfo(): DetectedShell | null {
  try {
    const { bin, args, type } = resolveShellBinary()
    return { bin, args, type }
  } catch {
    return null
  }
}

export function toOneShotShell(shell: DetectedShell): DetectedShell {
  switch (shell.type) {
    case 'posix':
    case 'msys':
      return { bin: shell.bin, args: ['-c'], type: shell.type }
    case 'wsl':
      return { bin: shell.bin, args: ['-e', 'bash', '-c'], type: shell.type }
    case 'powershell':
      return { bin: shell.bin, args: ['-NoProfile', '-Command'], type: shell.type }
    case 'cmd':
      return { bin: shell.bin, args: ['/c'], type: shell.type }
  }
}

export function getOneShotShellRuntimeInfo(): DetectedShell {
  return toOneShotShell(resolveShellBinary())
}

// 从环境变量检测 bash（SEMA_BASH / SHELL）
function detectBashFromEnv(): DetectedShell | null {
  // SEMA_BASH 环境变量优先级最高
  if (process.env.SEMA_BASH && tryBash(process.env.SEMA_BASH)) {
    logInfo(`使用 SEMA_BASH 环境变量指定的 bash: ${process.env.SEMA_BASH}`)
    return { bin: process.env.SEMA_BASH, args: ['-l'], type: 'msys' }
  }

  // SHELL 环境变量指向 bash.exe
  const shell = process.env.SHELL
  if (shell && /bash\.exe$/i.test(shell) && existsSync(shell)) {
    const isSystem32 = shell.toLowerCase().includes('system32')
    const type = isSystem32 ? 'wsl' as const : 'msys' as const
    if (testBashAvailability(shell, type)) {
      logInfo(`使用 SHELL 环境变量指定的 bash: ${shell}`)
      return { bin: shell, args: ['-l'], type }
    }
  }

  return null
}

// 获取 Windows PATH 条目
function getWindowsPathEntries(): string[] {
  let pathEnv = process.env.PATH || process.env.Path || process.env.path || ''

  // 遍历所有环境变量找 PATH（Windows 大小写不敏感）
  if (!pathEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toLowerCase() === 'path' && value) {
        pathEnv = value
        break
      }
    }
  }

  // PATH 看起来不完整时从 PowerShell 补充
  if (pathEnv && pathEnv.length < 500) {
    try {
      const fullPath = execSync('powershell.exe -Command "$env:PATH"', {
        encoding: 'utf8', timeout: 5000,
      }).trim()
      if (fullPath.length > pathEnv.length) pathEnv = fullPath
    } catch { /* ignore */ }
  }

  return splitPathEntries(pathEnv)
}

// 在 PATH 中搜索 bash.exe（Git Bash 优先）
function detectBashInPath(pathEntries: string[]): DetectedShell | null {
  // 单次遍历，Git Bash 优先收集，非 Git Bash 延后
  const nonGitCandidates: string[] = []

  for (const p of pathEntries) {
    const candidate = join(p, 'bash.exe')

    if (existsSync(candidate)) {
      const lower = candidate.toLowerCase()
      if (lower.includes('git') || lower.includes('git for windows')) {
        if (tryBash(candidate, 'msys'))
          return { bin: candidate, args: ['-l'], type: 'msys' }
      } else {
        nonGitCandidates.push(candidate)
      }
    } else {
      // Git cmd 目录 → 推断 bin 目录
      const pLower = p.toLowerCase()
      if (pLower.includes('git') && (pLower.endsWith('cmd') || pLower.endsWith('cmd\\'))) {
        const gitRoot = p.replace(/[\\\/]cmd[\\\/]?$/i, '')
        for (const sub of ['bin', 'usr/bin', 'mingw64/bin']) {
          const c = join(gitRoot, sub, 'bash.exe')
          if (tryBash(c, 'msys')) return { bin: c, args: ['-l'], type: 'msys' }
        }
      }
    }
  }

  // 非 Git Bash 候选
  for (const candidate of nonGitCandidates) {
    const isSystem32 = candidate.toLowerCase().includes('system32')
    const type = isSystem32 ? 'wsl' as const : 'msys' as const
    if (testBashAvailability(candidate, type))
      return { bin: candidate, args: ['-l'], type }
  }

  return null
}

// 在固定安装位置搜索 Git Bash / MSYS2
function detectBashInFixedLocations(): DetectedShell | null {
  const programFiles = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
  ].filter(Boolean) as string[]

  const candidates: string[] = []

  for (const base of programFiles) {
    candidates.push(
      join(base, 'Git', 'bin', 'bash.exe'),
      join(base, 'Git', 'usr', 'bin', 'bash.exe'),
    )
  }

  const localAppData = process.env['LocalAppData']
  if (localAppData) {
    candidates.push(
      join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
      join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    )
  }

  // MSYS2
  candidates.push('C:/msys64/usr/bin/bash.exe', 'C:/msys32/usr/bin/bash.exe')

  for (const candidate of candidates) {
    if (tryBash(candidate)) return { bin: candidate, args: ['-l'], type: 'msys' }
  }

  return null
}

// 检测 WSL
function detectWsl(): DetectedShell | null {
  try {
    execSync('wsl.exe -e bash -lc "echo SEMA_OK"', { stdio: 'ignore', timeout: 2000 })
    logInfo('WSL bash 可用')
    return { bin: 'wsl.exe', args: ['-e', 'bash', '-l'], type: 'wsl' }
  } catch {
    return null
  }
}

// 检测 PowerShell / cmd.exe 回退
function detectFallbackShell(): DetectedShell | null {
  // PowerShell
  for (const ps of ['pwsh.exe', 'powershell.exe']) {
    try {
      const result = execSync(`${ps} -NoProfile -Command "Write-Output 'SEMA_PS_OK'"`, {
        stdio: 'pipe', timeout: 3000, encoding: 'utf8',
      })
      if (result.toString().trim().includes('SEMA_PS_OK')) {
        logInfo(`使用 PowerShell: ${ps}`)
        return { bin: ps, args: ['-NoProfile', '-Command'], type: 'powershell' }
      }
    } catch { /* ignore */ }
  }

  // cmd.exe
  const comspec = process.env.ComSpec || 'cmd.exe'
  if (existsSync(comspec)) {
    logInfo(`使用 cmd.exe: ${comspec}`)
    return { bin: comspec, args: ['/k'], type: 'cmd' }
  }

  return null
}

function detectShellImpl(): DetectedShell {
  if (!IS_WIN) {
    return { bin: process.env.SHELL || '/bin/bash', args: ['-l'], type: 'posix' }
  }

  logInfo('开始检测 Windows Shell 环境...')

  // 按优先级依次尝试
  const result =
    detectBashFromEnv() ??
    detectBashInPath(getWindowsPathEntries()) ??
    detectBashInFixedLocations() ??
    detectWsl() ??
    detectFallbackShell()

  if (result) return result

  const hint = [
    '无法找到任何可用的 Shell 环境！',
    '',
    '建议解决方案：',
    '1. 安装 Git for Windows 获得 bash 支持: https://git-scm.com/download/win',
    '2. 或者启用 WSL: https://learn.microsoft.com/windows/wsl/install',
    '3. 确保 PowerShell 或 cmd.exe 可用',
    '',
    '你也可以通过设置 SEMA_BASH 环境变量指定 bash 路径',
  ].join('\n')

  logError(hint)
  throw new Error(hint)
}

// 持久化Shell类
export class PersistentShell {
  private commandQueue: PendingShellCommand[] = []  // 命令队列
  private isExecuting: boolean = false        // 是否正在执行命令
  private shell: ChildProcess                 // 子进程实例
  private isAlive: boolean = true             // Shell是否存活
  private commandInterrupted: boolean = false // 命令是否被中断
  private statusFile: string                  // 状态文件路径
  private stdoutFile: string                  // 标准输出文件路径
  private stderrFile: string                  // 标准错误文件路径
  private cwdFile: string                     // 当前工作目录文件路径
  private cwd: string                         // 当前工作目录
  private binShell: string                    // Shell二进制文件路径
  private shellArgs: string[]                 // Shell启动参数
  private shellType: ShellType // Shell类型
  private statusFileBashPath: string          // Bash格式的状态文件路径
  private stdoutFileBashPath: string          // Bash格式的标准输出文件路径
  private stderrFileBashPath: string          // Bash格式的标准错误文件路径
  private cwdFileBashPath: string             // Bash格式的当前工作目录文件路径
  private _exitCachedStdout: string = ''      // shell退出时缓存的stdout（防竞态）
  private _exitCachedStderr: string = ''      // shell退出时缓存的stderr（防竞态）

  constructor(cwd: string) {
    // 检测可用的Shell
    const { bin, args, type } = resolveShellBinary()
    this.binShell = bin
    this.shellArgs = args
    this.shellType = type

    // 启动Shell进程
    const spawnOptions: any = {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: {
        ...process.env,
        GIT_EDITOR: 'true',  // 禁用Git编辑器
      },
    }

    if (IS_WIN) spawnOptions.windowsHide = true

    this.shell = spawn(this.binShell, this.shellArgs, spawnOptions)

    this.cwd = cwd

    // 监听Shell退出事件
    this.shell.on('exit', (code, signal) => {
      if (code) {
        logError(`Shell exited with code ${code} and signal ${signal}`)
      }
      // 在删除文件前缓存内容，防止与 exec_() 的 readOutput() 产生竞态条件
      try {
        this._exitCachedStdout = fs.existsSync(this.stdoutFile) ? smartDecode(fs.readFileSync(this.stdoutFile)) : ''
        this._exitCachedStderr = fs.existsSync(this.stderrFile) ? filterCygwinNoise(smartDecode(fs.readFileSync(this.stderrFile))) : ''
      } catch {
        this._exitCachedStdout = ''
        this._exitCachedStderr = ''
      }
      // 清理临时文件
      for (const file of [
        this.statusFile,
        this.stdoutFile,
        this.stderrFile,
        this.cwdFile,
      ]) {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file)
        }
      }
      this.isAlive = false
    })

    // 生成随机ID用于临时文件
    const id = crypto.randomBytes(2).toString('hex')

    // 初始化临时文件路径
    this.statusFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STATUS
    this.stdoutFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STDOUT
    this.stderrFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STDERR
    this.cwdFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.CWD
    
    // 创建临时文件
    for (const file of [this.statusFile, this.stdoutFile, this.stderrFile]) {
      fs.writeFileSync(file, '')
    }
    // 初始化CWD文件，记录初始目录
    fs.writeFileSync(this.cwdFile, cwd)

    // 计算Bash可见的重定向路径（仅对 bash Shell 需要）
    if (this.shellType === 'msys' || this.shellType === 'wsl' || this.shellType === 'posix') {
      this.statusFileBashPath = nativeToShellPath(this.statusFile, this.shellType)
      this.stdoutFileBashPath = nativeToShellPath(this.stdoutFile, this.shellType)
      this.stderrFileBashPath = nativeToShellPath(this.stderrFile, this.shellType)
      this.cwdFileBashPath = nativeToShellPath(this.cwdFile, this.shellType)

      // 如果存在~/.bashrc则加载（适用于bash在POSIX/MSYS/WSL上）
      this.sendToShell('[ -f ~/.bashrc ] && source ~/.bashrc || true')
    } else {
      // 对于非 bash Shell，不需要路径转换
      this.statusFileBashPath = this.statusFile
      this.stdoutFileBashPath = this.stdoutFile
      this.stderrFileBashPath = this.stderrFile
      this.cwdFileBashPath = this.cwdFile

      logInfo(`${this.shellType} Shell 初始化完成，跳过 bashrc 加载`)
    }
  }

  // 单例实例
  private static instance: PersistentShell | null = null

  // 重启Shell实例
  static restart() {
    if (PersistentShell.instance) {
      PersistentShell.instance.close()
      PersistentShell.instance = null
    }
  }

  // 获取单例实例
  static getInstance(): PersistentShell {
    if (!PersistentShell.instance || !PersistentShell.instance.isAlive) {
      const cwd = PersistentShell.instance?.cwd || readInitialCwd()
      PersistentShell.instance = new PersistentShell(cwd)
    }
    return PersistentShell.instance
  }

  // 杀死子进程
  killChildren() {
    const parentPid = this.shell.pid
    if (!parentPid) {
      this.commandInterrupted = true
      return
    }

    try {
      if (IS_WIN) {
        // Windows: 使用 taskkill 终止进程树
        // 立即标记为不可用，防止 exit 事件异步触发前 getInstance() 返回死实例导致 EPIPE
        this.isAlive = false
        try {
          execSync(`taskkill /f /t /pid ${parentPid}`, { stdio: 'ignore', timeout: 5000 })
        } catch (error) {
          // 如果 taskkill 失败，尝试直接终止主进程
          try {
            process.kill(parentPid, 'SIGTERM')
          } catch (killError) {
            logError(`Failed to kill process ${parentPid}: ${killError}`)
          }
        }
      } else {
        // Unix: 使用 pgrep 获取子进程
        try {
          const childPids = execSync(`pgrep -P ${parentPid}`)
            .toString()
            .trim()
            .split('\n')
            .filter(Boolean) // 过滤空字符串

          // 杀死所有子进程
          childPids.forEach(pid => {
            try {
              process.kill(Number(pid), 'SIGTERM')
            } catch (error) {
              logError(`Failed to kill process ${pid}: ${error}`)
            }
          })
        } catch {
          // 没有子进程时是预期的行为
        }

        // 杀死 bash 进程本身，阻止 for 循环等在 shell 进程内运行的命令继续执行
        // 设置 isAlive=false，下次 getInstance() 会自动创建新的干净 shell
        try {
          this.isAlive = false
          process.kill(parentPid, 'SIGTERM')
        } catch (error) {
          logError(`Failed to kill shell process ${parentPid}: ${error}`)
        }
      }
    } catch {
      // 当没有找到进程时是预期的行为
    } finally {
      this.commandInterrupted = true
    }
  }

  // 处理命令队列
  private async processQueue() {
    /**
     * 从队列中逐个处理命令。
     * 并发不变性：
     * - 一次只有一个实例运行（由isExecuting控制）
     * - 是系统中唯一调用updateCwd()的地方
     * - 在每个命令完成后调用updateCwd()
     * - 通过队列确保命令串行执行
     * - 通过调用killChildren()处理abortSignal中断
     * - 在命令完成或中断后清理abortSignal监听器
     */
    if (this.isExecuting || this.commandQueue.length === 0) return

    this.isExecuting = true
    const { command, abortSignal, timeout, onChunk, onTimeout, resolve, reject } =
      this.commandQueue.shift()!

    // 中断处理函数
    const killChildren = () => this.killChildren()
    if (abortSignal) {
      abortSignal.addEventListener('abort', killChildren)
    }

    try {
      const result = await this.exec_(command, timeout, onChunk, onTimeout)

      // 不需要更新cwd - 在exec_中通过CWD文件处理

      resolve(result)
    } catch (error) {
      reject(error as Error)
    } finally {
      this.isExecuting = false
      if (abortSignal) {
        abortSignal.removeEventListener('abort', killChildren)
      }
      // 处理队列中的下一个命令
      this.processQueue()
    }
  }

  // 执行命令（公开方法）
  async exec(
    command: string,
    abortSignal?: AbortSignal,
    timeout?: number,
    onChunk?: (stdout: string, stderr: string) => void,
    onTimeout?: (ctx: TimeoutTransferContext) => void,
  ): Promise<ShellExecResult> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, abortSignal, timeout, onChunk, onTimeout, resolve, reject })
      this.processQueue()
    })
  }

  /**
   * 检查命令语法（语法错误提前返回，避免污染 shell 状态）
   * 返回 null 表示语法正常，返回 ShellExecResult 表示语法错误
   */
  private checkSyntax(command: string, quotedCommand: string): ShellExecResult | null {
    const syntaxCheckTimeout = IS_WIN ? 5000 : 1000
    try {
      if (this.shellType === 'wsl') {
        execSync(`wsl.exe -e bash -n -c ${quotedCommand}`, {
          stdio: 'ignore', timeout: syntaxCheckTimeout,
        })
      } else if (IS_WIN) {
        const { spawnSync } = require('child_process')
        const result = spawnSync(this.binShell, ['-n', '-c', command], {
          stdio: 'ignore', timeout: syntaxCheckTimeout, windowsHide: true,
        })
        if (result.status !== 0 || result.error) {
          throw result.error || new Error(`Syntax check failed with exit code ${result.status}`)
        }
      } else {
        execSync(`${this.binShell} -n -c ${quotedCommand}`, {
          stdio: 'ignore', timeout: syntaxCheckTimeout,
        })
      }
    } catch (err) {
      const isTimeout = (err as any)?.code === 'ETIMEDOUT' || (err as any)?.killed === true
      if (isTimeout) {
        logWarn(`语法检查超时，跳过并继续执行命令: ${command}`)
      } else {
        return { stdout: '', stderr: String(err || ''), code: 128, interrupted: false }
      }
    }
    return null
  }

  // 执行命令（内部实现）
  private async exec_(
    command: string,
    timeout?: number,
    onChunk?: (stdout: string, stderr: string) => void,
    onTimeout?: (ctx: TimeoutTransferContext) => void,
  ): Promise<ShellExecResult> {
    // 非 bash Shell 走单独路径
    if (this.shellType === 'cmd' || this.shellType === 'powershell') {
      return this.execNonBashShell(command, timeout, onChunk)
    }

    const quotedCommand = shellquote.quote([command])

    // 语法检查
    const syntaxError = this.checkSyntax(command, quotedCommand)
    if (syntaxError) return syntaxError

    const maxTimeout = timeout || DEFAULT_SHELL_TIMEOUT
    // 为新命令重置中断状态
    this.commandInterrupted = false

    return new Promise<ShellExecResult>(resolve => {
      // 清空输出文件
      fs.writeFileSync(this.stdoutFile, '')
      fs.writeFileSync(this.stderrFile, '')
      fs.writeFileSync(this.statusFile, '')

      // 使用命令数组清晰地分解命令序列
      const commandParts = []

      // 1. 重定向执行主命令，cd/export 等状态变更在命令间持久化
      // 注意：使用 <&- 关闭 stdin 而非 < /dev/null，以避免 Windows 下创建 nul 文件
      commandParts.push(
        `eval ${quotedCommand} <&- > ${quoteForBash(this.stdoutFileBashPath)} 2> ${quoteForBash(this.stderrFileBashPath)}`,
      )

      // 2. 命令执行后立即捕获退出码，避免丢失
      commandParts.push(`EXEC_EXIT_CODE=$?`)

      // 3. 更新CWD文件
      commandParts.push(`pwd > ${quoteForBash(this.cwdFileBashPath)}`)

      // 4. 将保存的退出码写入状态文件，避免与pwd竞争
      commandParts.push(`echo $EXEC_EXIT_CODE > ${quoteForBash(this.statusFileBashPath)}`)

      // 将组合命令作为单个操作发送以保持原子性
      this.sendToShell(commandParts.join('\n'))

      const start = Date.now()
      let lastSentStdout = ''           // 上次已发送的 stdout 内容（用于计算 delta）
      let lastSentStderr = ''           // 上次已发送的 stderr 内容（用于计算 delta）
      let lastChunkCheckTime = 0        // 上次流式输出检查时间
      let firstEmptyChunkSent = false   // 是否已发送过首次空 chunk
      let timer: ReturnType<typeof setTimeout> | null = null

      const finish = (result: ShellExecResult) => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        resolve(result)
      }

      const readOutput = (): { stdout: string; stderr: string } => ({
        stdout: fs.existsSync(this.stdoutFile)
          ? smartDecode(fs.readFileSync(this.stdoutFile))
          : this._exitCachedStdout,
        stderr: fs.existsSync(this.stderrFile)
          ? filterCygwinNoise(smartDecode(fs.readFileSync(this.stderrFile)))
          : this._exitCachedStderr,
      })

      const check = () => {
        try {
          const now = Date.now()
          const elapsed = now - start

          // 自适应轮询间隔：短命令快速响应，长命令降低频率
          let nextInterval: number
          if (elapsed < 2000) nextInterval = 10
          else if (elapsed < 10000) nextInterval = 100
          else nextInterval = 500

          // 检查状态文件（命令是否完成）
          let statusFileSize = 0
          if (fs.existsSync(this.statusFile)) {
            statusFileSize = fs.statSync(this.statusFile).size
          }

          // 流式输出检查：每CHUNK_CHECK_INTERVAL检查一次，有变化才触发 onChunk（仅发送 delta）
          if (now - lastChunkCheckTime >= CHUNK_CHECK_INTERVAL) {
            lastChunkCheckTime = now
            const { stdout, stderr } = readOutput()
            const hasNewStdout = stdout.length > lastSentStdout.length
            const hasNewStderr = stderr.length > lastSentStderr.length
            if (hasNewStdout || hasNewStderr) {
              const deltaStdout = stdout.slice(lastSentStdout.length)
              const deltaStderr = stderr.slice(lastSentStderr.length)
              lastSentStdout = stdout
              lastSentStderr = stderr
              if (onChunk) {
                onChunk(deltaStdout, deltaStderr)
              }
            } else if (!firstEmptyChunkSent && !stdout && !stderr && onChunk) {
              // 首次检测到输出为空时发送一次空 chunk
              firstEmptyChunkSent = true
              onChunk('', '')
            }
          }

          if (statusFileSize > 0) {
            // 命令正常完成
            const { stdout, stderr } = readOutput()
            const code = Number(fs.readFileSync(this.statusFile, 'utf8'))
            finish({ stdout, stderr, code, interrupted: this.commandInterrupted })
          } else if (this.commandInterrupted) {
            // 命令被外部中断（如用户取消）
            const { stdout, stderr } = readOutput()
            finish({ stdout, stderr, code: SIGTERM_CODE, interrupted: true })
          } else if (elapsed >= maxTimeout) {
            if (onTimeout) {
              // 超时接管：将旧 shell 及临时文件交给 TaskManager，新命令创建新 shell
              const { stdout } = readOutput()
              // reject 队列中所有等待的命令，防止它们被发到旧 shell
              this.commandQueue.forEach(cmd =>
                cmd.reject(new Error('Shell transferred to background task'))
              )
              this.commandQueue = []
              // 调用接管回调
              onTimeout({
                stdoutFile: this.stdoutFile,
                stderrFile: this.stderrFile,
                statusFile: this.statusFile,
                shellProcess: this.shell,
                partialOutput: stdout,
              })
              // 重置单例，后续命令自动创建新 shell
              PersistentShell.instance = null
              // code=-1 为后台接管标记，Bash.ts 检测此值
              finish({ stdout: '', stderr: '', code: -1, interrupted: false })
            } else {
              // 原有逻辑：kill 并返回已有的部分输出
              this.killChildren()
              const { stdout, stderr } = readOutput()
              finish({
                stdout,
                stderr: (stderr ? stderr + '\n' : '') + `(timeout ${humanizeDuration(maxTimeout)})`,
                code: SIGTERM_CODE,
                interrupted: this.commandInterrupted,
              })
            }
          } else {
            timer = setTimeout(check, nextInterval)
          }
        } catch {
          // 在轮询期间忽略文件系统错误 - 它们是预期的
          const elapsed = Date.now() - start
          let nextInterval: number
          if (elapsed < 2000) nextInterval = 10
          else if (elapsed < 10000) nextInterval = 100
          else nextInterval = 500
          timer = setTimeout(check, nextInterval)
        }
      }

      timer = setTimeout(check, 10)
    })
  }

  // 非 Bash Shell 特殊处理 (PowerShell, cmd.exe)
  private async execNonBashShell(
    command: string,
    timeout?: number,
    onChunk?: (stdout: string, stderr: string) => void,
  ): Promise<ShellExecResult> {
    const commandTimeout = timeout || DEFAULT_SHELL_TIMEOUT
    this.commandInterrupted = false

    return new Promise<ShellExecResult>(resolve => {
      try {
        let shellArgs: string[]
        if (this.shellType === 'powershell') {
          // PowerShell 命令处理
          shellArgs = ['-NoProfile', '-Command', command]
        } else if (this.shellType === 'cmd') {
          // cmd.exe 命令处理
          shellArgs = ['/c', command]
        } else {
          // 回退处理
          shellArgs = [command]
        }

        logInfo(`执行 ${this.shellType} 命令: ${command}`)

        // 直接使用对应的 Shell 执行命令
        const childProcess = spawn(this.binShell, shellArgs, {
          cwd: this.cwd,
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })

        let stdout = ''
        let stderr = ''
        let completed = false

        // 收集输出并触发流式 chunk 回调
        if (childProcess.stdout) {
          childProcess.stdout.on('data', (data) => {
            stdout += data.toString()
            if (onChunk) onChunk(stdout, stderr)
          })
        }

        if (childProcess.stderr) {
          childProcess.stderr.on('data', (data) => {
            stderr += data.toString()
            if (onChunk) onChunk(stdout, stderr)
          })
        }

        // 设置超时
        const timer = setTimeout(() => {
          if (!completed) {
            completed = true
            childProcess.kill('SIGTERM')
            resolve({
              stdout,
              stderr: stderr + `\n(timeout ${humanizeDuration(commandTimeout)})`,
              code: SIGTERM_CODE,
              interrupted: true,
            })
          }
        }, commandTimeout)

        // 处理进程退出
        childProcess.on('exit', (code, signal) => {
          if (!completed) {
            completed = true
            clearTimeout(timer)
            resolve({
              stdout,
              stderr,
              code: code || 0,
              interrupted: this.commandInterrupted,
            })
          }
        })

        childProcess.on('error', (error) => {
          if (!completed) {
            completed = true
            clearTimeout(timer)
            resolve({
              stdout,
              stderr: stderr + '\n' + error.message,
              code: 1,
              interrupted: false,
            })
          }
        })

      } catch (error) {
        resolve({
          stdout: '',
          stderr: String(error),
          code: 1,
          interrupted: false,
        })
      }
    })
  }

  // 向Shell发送命令
  private sendToShell(command: string) {
    try {
      this.shell!.stdin!.write(command + '\n')
    } catch (error) {
      const errorString =
        error instanceof Error
          ? error.message
          : String(error || 'Unknown error')
      logError(`Error in sendToShell: ${errorString}`)
      throw error
    }
  }

  // 获取当前工作目录
  pwd(): string {
    // 对于非 bash Shell，直接返回缓存的目录
    if (this.shellType === 'cmd' || this.shellType === 'powershell') {
      return this.cwd
    }

    try {
      const newCwd = fs.readFileSync(this.cwdFile, 'utf8').trim()
      if (newCwd) {
        this.cwd = newCwd
      }
    } catch (error) {
      logError(`Shell pwd error ${error}`)
    }
    // 总是返回缓存的值
    return this.cwd
  }

  // 设置当前工作目录
  async setCwd(cwd: string) {
    const resolved = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)
    if (!existsSync(resolved)) {
      throw new Error(`Path "${resolved}" does not exist`)
    }

    // 对于非 bash Shell，直接更新缓存的目录
    if (this.shellType === 'cmd' || this.shellType === 'powershell') {
      this.cwd = resolved
      logInfo(`${this.shellType} 工作目录更新为: ${resolved}`)
      return
    }

    const bashPath = nativeToShellPath(resolved, this.shellType)
    await this.exec(`cd ${quoteForBash(bashPath)}`)
  }

  // 关闭Shell
  close(): void {
    this.shell!.stdin!.end()
    this.shell.kill()
  }
}

// ==================== 输出格式化 ====================

export const STDOUT_HEAD_TAIL_LINES = 500
export const STDERR_HEAD_TAIL_LINES = 50
const MAX_LINE_LENGTH = 2000

function truncateLines(lines: string[]): string[] {
  return lines.map(l =>
    l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + '...[line truncated]' : l,
  )
}

export function formatOutput(content: string, headTailLines = STDOUT_HEAD_TAIL_LINES, { resolveCR = true }: { resolveCR?: boolean } = {}) {
  // 处理 \r（回车符）：模拟终端行为，只保留每行最后一次 \r 后的内容
  const resolved = resolveCR
    ? content.split('\n').map(line => {
        if (!line.includes('\r')) return line
        const parts = line.split('\r')
        return parts[parts.length - 1]
      }).join('\n')
    : content
  const lines = truncateLines(resolved.split('\n'))
  const totalLines = lines.length
  const skipped = totalLines - headTailLines * 2

  return {
    totalLines,
    truncatedContent: skipped <= 0
      ? lines.join('\n')
      : [...lines.slice(0, headTailLines), `\n... [${skipped} lines truncated] ...\n`, ...lines.slice(-headTailLines)].join('\n'),
  }
}

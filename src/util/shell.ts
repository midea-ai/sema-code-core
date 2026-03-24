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

// 临时文件前缀
const TEMPFILE_PREFIX = join(os.tmpdir(), 'sema-')

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const min = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${min}min${rem}s` : `${min}min`
}
// 默认超时时间（2分钟）
const DEFAULT_TIMEOUT = 120 * 1000
// SIGTERM信号的标准退出码
const SIGTERM_CODE = 143
// 文件后缀定义
const FILE_SUFFIXES = {
  STATUS: '-status',    // 状态文件后缀
  STDOUT: '-stdout',    // 标准输出文件后缀
  STDERR: '-stderr',    // 标准错误文件后缀
  CWD: '-cwd',          // 当前工作目录文件后缀
}

// 执行结果类型定义
type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
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

// 队列中的命令类型定义
type QueuedCommand = {
  command: string
  abortSignal?: AbortSignal
  timeout?: number
  onChunk?: (stdout: string, stderr: string) => void
  resolve: (result: ExecResult) => void
  reject: (error: Error) => void
}

// Shell配置文件映射
const SHELL_CONFIGS: Record<string, string> = {
  '/bin/bash': '.bashrc',
  '/bin/zsh': '.zshrc',
}

// 检测到的Shell信息类型
type DetectedShell = {
  bin: string           // Shell二进制文件路径
  args: string[]        // 启动参数
  type: 'posix' | 'msys' | 'wsl' | 'powershell' | 'cmd'  // Shell类型
}

// 为Bash转义字符串
function quoteForBash(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`
}

// 检查文件是否存在
function fileExists(p: string | undefined): p is string {
  return !!p && existsSync(p)
}

// testBashAvailability 结果缓存，避免对同一路径重复测试
const bashTestCache = new Map<string, boolean>()

// 测试 bash 是否可用
function testBashAvailability(bashPath: string, type: 'msys' | 'wsl' = 'msys'): boolean {
  const cacheKey = `${bashPath}:${type}`
  const cached = bashTestCache.get(cacheKey)
  if (cached !== undefined) return cached

  const saveAndReturn = (result: boolean) => {
    bashTestCache.set(cacheKey, result)
    return result
  }

  try {
    logInfo(`测试 bash 可用性: ${bashPath}`)
    const testCommand = `"${bashPath}" -c "echo SEMA_TEST_OK"`
    const result = execSync(testCommand, {
      stdio: 'pipe',
      timeout: 3000,
      encoding: 'utf8'
    })

    const output = result.toString().trim()
    if (output.includes('SEMA_TEST_OK')) {
      logInfo(`✅ bash 测试通过: ${bashPath}`)
      return saveAndReturn(true)
    } else {
      logWarn(`❌ bash 测试失败，输出不符合预期: ${bashPath}, 输出: ${output}`)
      return saveAndReturn(false)
    }
  } catch (error) {
    logWarn(`❌ bash 测试失败: ${bashPath}, 错误: ${error}`)
    return saveAndReturn(false)
  }
}

// 判断路径是否为 Git Bash
function isGitBashPath(p: string): boolean {
  const lower = p.toLowerCase()
  return lower.includes('git') || lower.includes('git for windows')
}

// 检测可用的Shell（结果缓存，避免重复探测）
let detectedShellCache: DetectedShell | null = null

function detectShell(): DetectedShell {
  if (detectedShellCache) return detectedShellCache
  detectedShellCache = detectShellImpl()
  return detectedShellCache
}

function detectShellImpl(): DetectedShell {
  if (!IS_WIN) {
    const bin = process.env.SHELL || '/bin/bash'
    return { bin, args: ['-l'], type: 'posix' }
  }

  logInfo('开始检测 Windows Shell 环境...')

  // Windows 平台 Shell 检测逻辑 - 优化后的检测顺序

  // 1) 显式环境变量优先级最高 (支持 SEMA_BASH 环境变量)
  if (process.env.SEMA_BASH && existsSync(process.env.SEMA_BASH)) {
    if (testBashAvailability(process.env.SEMA_BASH)) {
      logInfo(`使用 SEMA_BASH 环境变量指定的 bash: ${process.env.SEMA_BASH}`)
      return { bin: process.env.SEMA_BASH, args: ['-l'], type: 'msys' }
    } else {
      logWarn(`SEMA_BASH 指定的 bash 测试失败: ${process.env.SEMA_BASH}`)
    }
  }

  // 1.1) 如果SHELL环境变量指向存在的bash.exe，则测试并使用它
  if (process.env.SHELL && /bash\.exe$/i.test(process.env.SHELL) && existsSync(process.env.SHELL)) {
    // 对 System32 bash 进行特殊测试
    const isSystem32Bash = process.env.SHELL.toLowerCase().includes('system32')
    const testType = isSystem32Bash ? 'wsl' : 'msys'

    if (testBashAvailability(process.env.SHELL, testType)) {
      logInfo(`使用 SHELL 环境变量指定的 bash: ${process.env.SHELL}`)
      return { bin: process.env.SHELL, args: ['-l'], type: isSystem32Bash ? 'wsl' : 'msys' }
    } else {
      logWarn(`SHELL 环境变量指定的 bash 测试失败: ${process.env.SHELL}`)
    }
  }

  // 2) 优先在PATH中搜索bash.exe (提前到这里，覆盖更多安装方式)
  logInfo('在 PATH 中搜索 bash.exe...')

  // 在Windows上尝试多种PATH环境变量形式
  let pathEnv = process.env.PATH || process.env.Path || process.env.path || ''

  // 如果还是空的，尝试遍历所有环境变量找到PATH
  if (!pathEnv) {
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toLowerCase() === 'path' && value) {
        pathEnv = value
        logInfo(`找到 PATH 环境变量 (${key}): ${value.substring(0, 100)}...`)
        break
      }
    }
  }

  if (IS_WIN && pathEnv && pathEnv.length < 500) {
    try {
      logInfo('PATH看起来不完整，尝试从PowerShell重新获取...')
      const fullPath = execSync('powershell.exe -Command "$env:PATH"', {
        encoding: 'utf8',
        timeout: 5000
      }).trim()
      if (fullPath && fullPath.length > pathEnv.length) {
        logInfo(`从PowerShell获取到更完整的PATH (${fullPath.length} vs ${pathEnv.length} 字符)`)
        pathEnv = fullPath
      }
    } catch (error) {
      logWarn(`无法从PowerShell获取PATH: ${error}`)
    }
  }

  logInfo(`PATH 环境变量内容: ${pathEnv ? pathEnv.substring(0, 200) + '...' : '(空)'}`)
  const pathEntries = splitPathEntries(pathEnv)
  logInfo(`解析出的 PATH 条目数量: ${pathEntries.length}`)

  // 打印前几个路径条目用于调试
  pathEntries.slice(0, 5).forEach((entry, index) => {
    logInfo(`PATH[${index}]: ${entry}`)
  })

  // 2.1) 首先优先处理PATH中的Git Bash
  logInfo('优先检查 PATH 中的 Git Bash...')
  for (const p of pathEntries) {
    const candidate = join(p, 'bash.exe')
    logInfo(`检查路径: ${candidate}`)
    if (existsSync(candidate)) {
      // 检查是否为Git Bash路径 - 更宽泛的检测
      const isGitBash = isGitBashPath(candidate)
      logInfo(`发现 bash.exe: ${candidate}, 是否Git Bash: ${isGitBash}`)
      if (isGitBash) {
        if (testBashAvailability(candidate, 'msys')) {
          logInfo(`在 PATH 中找到可用的 Git Bash: ${candidate}`)
          return { bin: candidate, args: ['-l'], type: 'msys' }
        } else {
          logWarn(`PATH 中的 Git Bash 测试失败，跳过: ${candidate}`)
        }
      }
    } else {
      // 如果是Git的cmd目录，检查对应的bin目录和usr/bin目录
      const pLower = p.toLowerCase()
      if (pLower.includes('git') && (pLower.endsWith('cmd') || pLower.endsWith('cmd\\'))) {
        logInfo(`检测到Git cmd目录: ${p}，尝试查找对应的bin目录`)

        // 尝试多个可能的bin目录位置
        const gitRoot = p.replace(/[\\\/]cmd[\\\/]?$/i, '')
        const binCandidates = [
          join(gitRoot, 'bin', 'bash.exe'),
          join(gitRoot, 'usr', 'bin', 'bash.exe'),
          join(gitRoot, 'mingw64', 'bin', 'bash.exe')
        ]

        for (const binCandidate of binCandidates) {
          logInfo(`尝试Git Bash路径: ${binCandidate}`)
          if (existsSync(binCandidate)) {
            logInfo(`发现 bash.exe: ${binCandidate}, 是否Git Bash: true`)
            if (testBashAvailability(binCandidate, 'msys')) {
              logInfo(`在 PATH 中找到可用的 Git Bash (通过cmd->bin映射): ${binCandidate}`)
              return { bin: binCandidate, args: ['-l'], type: 'msys' }
            } else {
              logWarn(`Git Bash 测试失败，跳过: ${binCandidate}`)
            }
          }
        }
      }
    }
  }

  // 2.2) 然后处理PATH中的其他bash
  logInfo('检查 PATH 中的其他 bash...')
  for (const p of pathEntries) {
    const candidate = join(p, 'bash.exe')
    if (existsSync(candidate)) {
      // 跳过已经处理过的Git Bash
      if (!isGitBashPath(candidate)) {
        // 对所有找到的 bash 进行测试验证
        const isSystem32Bash = candidate.toLowerCase().includes('system32')
        const testType = isSystem32Bash ? 'wsl' : 'msys'

        if (testBashAvailability(candidate, testType)) {
          logInfo(`在 PATH 中找到可用的 bash: ${candidate}`)
          return { bin: candidate, args: ['-l'], type: isSystem32Bash ? 'wsl' : 'msys' }
        } else {
          logWarn(`PATH 中的 bash 测试失败，跳过: ${candidate}`)
        }
      }
    }
  }

  // 3) 检测 Git Bash 的常见固定位置 (作为 PATH 搜索的补充)
  logInfo('搜索 Git Bash 固定安装位置...')
  const programFiles = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['ProgramW6432'],
  ].filter(Boolean) as string[]

  const localAppData = process.env['LocalAppData']

  const gitBashCandidates: string[] = []

  // Git for Windows 标准安装位置
  for (const base of programFiles) {
    gitBashCandidates.push(
      join(base, 'Git', 'bin', 'bash.exe'),
      join(base, 'Git', 'usr', 'bin', 'bash.exe'),
    )
  }

  // 用户级安装位置
  if (localAppData) {
    gitBashCandidates.push(
      join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
      join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    )
  }

  // 检查 Git Bash 候选位置
  for (const candidate of gitBashCandidates) {
    if (existsSync(candidate)) {
      if (testBashAvailability(candidate)) {
        logInfo(`找到 Git Bash: ${candidate}`)
        return { bin: candidate, args: ['-l'], type: 'msys' }
      } else {
        logWarn(`Git Bash 测试失败，跳过: ${candidate}`)
      }
    }
  }

  // 3.1) MSYS2 位置
  const msys2Candidates = [
    'C:/msys64/usr/bin/bash.exe',
    'C:/msys32/usr/bin/bash.exe',
  ]

  for (const candidate of msys2Candidates) {
    if (existsSync(candidate)) {
      if (testBashAvailability(candidate)) {
        logInfo(`找到 MSYS2 bash: ${candidate}`)
        return { bin: candidate, args: ['-l'], type: 'msys' }
      } else {
        logWarn(`MSYS2 bash 测试失败，跳过: ${candidate}`)
      }
    }
  }

  // 4) 尝试 WSL (仅当明确可用时)
  logInfo('检测 WSL 环境...')
  try {
    // 快速探测确保WSL+bash存在且可用
    execSync('wsl.exe -e bash -lc "echo SEMA_OK"', { stdio: 'ignore', timeout: 2000 })
    logInfo('WSL bash 可用')
    return { bin: 'wsl.exe', args: ['-e', 'bash', '-l'], type: 'wsl' }
  } catch (error) {
    logWarn(`WSL 检测失败: ${error}`)
  }

  // 5) 回退到 PowerShell (Windows 现代 Shell)
  logInfo('尝试使用 PowerShell 作为回退方案...')
  const powershellCandidates = [
    'pwsh.exe',        // PowerShell 7+
    'powershell.exe',  // Windows PowerShell 5.x
  ]

  for (const psCandidate of powershellCandidates) {
    try {
      // 测试 PowerShell 是否可用
      // 修复: 增加超时时间，使用NoProfile参数，验证输出
      const result = execSync(`${psCandidate} -NoProfile -Command "Write-Output 'SEMA_PS_OK'"`, {
        stdio: 'pipe',
        timeout: 3000,  // 从1000ms增加到3000ms
        encoding: 'utf8'
      })

      // 验证输出内容
      if (result.toString().trim().includes('SEMA_PS_OK')) {
        logInfo(`使用 PowerShell: ${psCandidate}`)
        return { bin: psCandidate, args: ['-NoProfile', '-Command'], type: 'powershell' }
      } else {
        logWarn(`PowerShell ${psCandidate} 测试输出不符合预期: ${result.toString().trim()}`)
      }
    } catch (error) {
      logWarn(`PowerShell ${psCandidate} 不可用: ${error}`)
    }
  }

  // 6) 最后回退到 cmd.exe
  logWarn('回退到 Windows 命令提示符 (cmd.exe)')
  try {
    const comspec = process.env.ComSpec || 'cmd.exe'
    if (existsSync(comspec)) {
      logInfo(`使用 cmd.exe: ${comspec}`)
      return { bin: comspec, args: ['/k'], type: 'cmd' }
    }
  } catch (error) {
    logError(`cmd.exe 检测失败: ${error}`)
  }

  // 7) 最后的手段：提供详细的错误信息和建议
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
  private commandQueue: QueuedCommand[] = []  // 命令队列
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
  private shellType: 'posix' | 'msys' | 'wsl' | 'powershell' | 'cmd' // Shell类型
  private statusFileBashPath: string          // Bash格式的状态文件路径
  private stdoutFileBashPath: string          // Bash格式的标准输出文件路径
  private stderrFileBashPath: string          // Bash格式的标准错误文件路径
  private cwdFileBashPath: string             // Bash格式的当前工作目录文件路径
  private _exitCachedStdout: string = ''      // shell退出时缓存的stdout（防竞态）
  private _exitCachedStderr: string = ''      // shell退出时缓存的stderr（防竞态）

  constructor(cwd: string) {
    // 检测可用的Shell
    const { bin, args, type } = detectShell()
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
        // TODO: 最好能通知用户Shell崩溃了
        logError(`Shell exited with code ${code} and signal ${signal}`)
      }
      // 在删除文件前缓存内容，防止与 exec_() 的 readOutput() 产生竞态条件
      try {
        this._exitCachedStdout = fs.existsSync(this.stdoutFile) ? smartDecode(fs.readFileSync(this.stdoutFile)) : ''
        this._exitCachedStderr = fs.existsSync(this.stderrFile) ? smartDecode(fs.readFileSync(this.stderrFile)) : ''
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
      const cwd = PersistentShell.instance?.cwd || process.cwd()
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
    const { command, abortSignal, timeout, onChunk, resolve, reject } =
      this.commandQueue.shift()!

    // 中断处理函数
    const killChildren = () => this.killChildren()
    if (abortSignal) {
      abortSignal.addEventListener('abort', killChildren)
    }

    try {
      const result = await this.exec_(command, timeout, onChunk)

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
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({ command, abortSignal, timeout, onChunk, resolve, reject })
      this.processQueue()
    })
  }

  // 执行命令（内部实现）
  private async exec_(
    command: string,
    timeout?: number,
    onChunk?: (stdout: string, stderr: string) => void,
  ): Promise<ExecResult> {
    /**
     * 直接执行命令，不经过队列。
     * 并发不变性：
     * - 不适合并发调用（使用共享文件）
     * - 仅在队列空闲时调用
     * - 依赖基于文件的IPC处理Shell交互
     * - 不修改命令队列状态
     * - 通过commandInterrupted标志跟踪中断状态
     * - 在新命令开始时重置中断状态
     * - 在结果对象中报告中断状态
     *
     * 超时机制：
     * - idle timeout: ${IDLE_TIMEOUT_MS/1000}秒无新输出 → kill（每次有输出变化则重置）
     * - max timeout: min(用户传入 timeout, 3min) → kill（从命令开始倒计时，不重置）
     * - 谁先触发谁 kill，超时后仍返回已写入临时文件的部分输出
     *
     * 退出码和CWD处理：
     * - 执行命令并立即将其退出码捕获到Shell变量中
     * - 捕获退出码后更新CWD文件的工作目录
     * - 将保存的退出码作为最后一步写入状态文件
     * - 此序列消除了退出码捕获和CWD更新之间的竞争条件
     * - pwd()方法直接读取CWD文件获取当前目录信息
     */

    // 如果是非 bash Shell，需要特殊处理
    if (this.shellType === 'cmd' || this.shellType === 'powershell') {
      return this.execNonBashShell(command, timeout, onChunk)
    }

    const quotedCommand = shellquote.quote([command])

    // 检查命令语法（语法错误提前返回，避免污染 shell 状态）
    // Windows 上 spawn 子进程较慢，使用更长超时
    const syntaxCheckTimeout = IS_WIN ? 5000 : 1000
    try {
      if (this.shellType === 'wsl') {
        execSync(`wsl.exe -e bash -n -c ${quotedCommand}`, {
          stdio: 'ignore',
          timeout: syntaxCheckTimeout,
        })
      } else {
        const quotedBinShell = IS_WIN ? `"${this.binShell}"` : this.binShell
        execSync(`${quotedBinShell} -n -c ${quotedCommand}`, {
          stdio: 'ignore',
          timeout: syntaxCheckTimeout,
        })
      }
    } catch (err) {
      // 超时（ETIMEDOUT）说明无法完成语法检查，不等于语法错误，继续执行
      const isTimeout = (err as any)?.code === 'ETIMEDOUT' || (err as any)?.killed === true
      if (isTimeout) {
        logWarn(`语法检查超时，跳过并继续执行命令: ${command}`)
      } else {
        // 真正的语法错误，提前返回
        const errorStr =
          typeof err === 'string' ? err : String(err || '')
        return Promise.resolve({
          stdout: '',
          stderr: errorStr,
          code: 128,
          interrupted: false,
        })
      }
    }

    const maxTimeout = timeout || DEFAULT_TIMEOUT
    // 为新命令重置中断状态
    this.commandInterrupted = false

    return new Promise<ExecResult>(resolve => {
      // 清空输出文件
      fs.writeFileSync(this.stdoutFile, '')
      fs.writeFileSync(this.stderrFile, '')
      fs.writeFileSync(this.statusFile, '')

      // 使用命令数组清晰地分解命令序列
      const commandParts = []

      // 1. 重定向执行主命令，cd/export 等状态变更在命令间持久化
      commandParts.push(
        `eval ${quotedCommand} < /dev/null > ${quoteForBash(this.stdoutFileBashPath)} 2> ${quoteForBash(this.stderrFileBashPath)}`,
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
      let lastOutputSnapshot = ''       // 上次检测到的输出快照，用于判断是否有变化
      let lastChunkCheckTime = 0        // 上次流式输出检查时间
      let firstEmptyChunkSent = false   // 是否已发送过首次空 chunk
      let timer: ReturnType<typeof setTimeout> | null = null

      const finish = (result: ExecResult) => {
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
          ? smartDecode(fs.readFileSync(this.stderrFile))
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

          // 流式输出检查：每500ms检查一次，有变化才触发 onChunk
          if (now - lastChunkCheckTime >= 500) {
            lastChunkCheckTime = now
            const { stdout, stderr } = readOutput()
            const snapshot = stdout + stderr
            if (snapshot !== lastOutputSnapshot) {
              lastOutputSnapshot = snapshot
              if (onChunk) {
                onChunk(stdout, stderr)
              }
            } else if (!firstEmptyChunkSent && !snapshot && onChunk) {
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
            // 超过最大执行时间，kill 并返回已有的部分输出
            this.killChildren()
            const { stdout, stderr } = readOutput()
            finish({
              stdout,
              stderr: (stderr ? stderr + '\n' : '') + `(timeout ${formatDuration(maxTimeout)})`,
              code: SIGTERM_CODE,
              interrupted: this.commandInterrupted,
            })
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
  ): Promise<ExecResult> {
    const commandTimeout = timeout || DEFAULT_TIMEOUT
    this.commandInterrupted = false

    return new Promise<ExecResult>(resolve => {
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
              stderr: stderr + `\n(timeout ${formatDuration(commandTimeout)})`,
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
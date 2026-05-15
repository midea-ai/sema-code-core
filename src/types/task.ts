import { type ChildProcess } from 'child_process'

export type CronTaskStatus = 'running' | 'completed' | 'failed' | 'killed'

/**
 * 后台任务记录
 *
 * 有两种来源：
 * 1. background=true：run_shell 工具直接通过 spawnRunShellTask() 创建独立子进程
 * 2. 命令执行超时：PersistentShell 将旧 shell 移交给 takeoverTask()，继续轮询其临时文件
 * 3. 异步Agent
 */
export interface TaskRecord {
  /** 任务唯一 ID（随机 4 字节 hex） */
  taskId: string
  /** 进程 ID，用于确认进程是否已终止 */
  pid?: number
  /** 任务类型，RunShell SubAgent */
  type: 'RunShell' | 'SubAgent'
  /** shell命令字符串 或 agent标题 */
  command: string
  /** 触发该任务的 tool_use_id，用于通知回调关联原始请求 */
  toolUseId: string
  /** 任务输出写入的本地临时文件路径（供 peek_bg_job 工具读取） */
  filepath: string
  /** 任务当前状态 */
  status: CronTaskStatus
  /** 内存中缓存的输出内容（上限 2MB，超出时截断保留末尾） */
  output: string
  /** 进程退出码（任务结束后赋值） */
  exitCode?: number
  /** spawnRunShellTask 创建的独立子进程（background 路径） */
  _process?: ChildProcess
  /** takeoverTask 接管的旧 PersistentShell 进程（超时路径） */
  _shellProcess?: ChildProcess
  /** takeoverTask 轮询旧 shell 临时文件的定时器 */
  _pollTimer?: ReturnType<typeof setInterval>
  /** Agent 任务专用：独立的 AbortController，用于停止后台 agent */
  _abortController?: AbortController
  /** 是否为前台任务（前台 Agent 注册时为 true，转后台时改为 false） */
  foreground?: boolean
  /** 前台转后台的 resolve 回调，调用后 Promise.race 立刻返回 */
  _transferResolve?: () => void
  /** 解除子 AC 与主 AC 的联动，转后台时调用 */
  _unlinkAbort?: () => void
  /** Agent 任务专用：执行 Promise */
  _promise?: Promise<void>
  /** Agent 任务专用：代理类型（对应 agent_type） */
  agentType?: string
  /** 任务启动时间戳（ms） */
  startTime: number
  /** 任务结束时间戳（ms） */
  endTime?: number
  /** Agent 任务专用：执行统计（tokens / 工具调用 / 耗时） */
  usage?: {
    totalTokens: number
    toolUses: number
    durationMs: number
  }
}

/**
 * 超时接管上下文
 *
 * 当 PersistentShell 执行命令超时时，由 shell.ts 构造并传递给 TaskManager.takeoverTask()。
 * 包含旧 shell 的临时文件路径和进程引用，让 TaskManager 能继续轮询命令的后续输出，
 * 直到命令通过 statusFile 报告完成或 shell 进程异常退出。
 */
export interface TimeoutTransferContext {
  /** 旧 shell 写命令 stdout 的临时文件路径 */
  stdoutFile: string
  /** 旧 shell 写命令 stderr 的临时文件路径 */
  stderrFile: string
  /** 旧 shell 写命令退出码的临时文件路径（非空即代表命令完成） */
  statusFile: string
  /** 旧 PersistentShell 子进程引用（超时后由 TaskManager 负责 kill） */
  shellProcess: ChildProcess
  /** 超时前已读取到的部分输出，作为任务输出的初始内容 */
  partialOutput: string
}

/**
 * 任务列表项（对外暴露的简洁格式）
 */
export interface TaskListItem {
  taskId: string
  pid?: number
  filepath: string
  status: CronTaskStatus
  type: string
  command: string
  agentType?: string
  foreground?: boolean
  startTime: number
  endTime?: number
}
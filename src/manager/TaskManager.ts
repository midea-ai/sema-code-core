import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { spawn } from 'child_process'
import { IS_WIN } from '../util/platform'
import { logInfo, logError, logWarn } from '../util/log'
import { getEventBus } from '../events/EventSystem'
import { TaskRecord, TaskListItem, TimeoutTransferContext } from '../types/task'
import { MAX_OUTPUT_BYTES, TASK_OUTPUT_DIR, ensureTaskDir, getShellForSpawn, killProcess } from '../util/process'
import { SessionNotifyRegistry, NotifyCallback } from '../util/notifyRegistry'
import { readInitialCwd } from '../util/cwd'

export class TaskManager {
  private static MAX_FINISHED_TASKS = 50
  private static MAX_RUNNING_TASKS = 5
  private tasks = new Map<string, TaskRecord>()
  private watchers = new Map<string, Set<(delta: string) => void>>()
  /** 按 sessionId 注册的通知回调，后台任务完成时通知归属会话 */
  private notifyRegistry = new SessionNotifyRegistry()

  setNotifyCallback(sessionId: string, cb: NotifyCallback) {
    this.notifyRegistry.set(sessionId, cb)
  }

  removeNotifyCallback(sessionId: string) {
    this.notifyRegistry.remove(sessionId)
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  getTasks(): TaskRecord[] {
    return Array.from(this.tasks.values())
  }

  getTaskList(sessionId?: string): TaskListItem[] {
    return Array.from(this.tasks.values())
      .filter(t => !t.foreground)
      .filter(t => !sessionId || t.sessionId === sessionId)
      .map(t => ({
        taskId: t.taskId,
        pid: t.pid,
        filepath: t.filepath,
        status: t.status,
        type: t.type,
        command: t.command,
        agentType: t.agentType,
        foreground: t.foreground,
        startTime: t.startTime,
        endTime: t.endTime,
      }))
  }

  getRunningTasks(): TaskRecord[] {
    return Array.from(this.tasks.values()).filter(t => t.status === 'running')
  }

  /**
   * 统计指定会话正在运行的任务数
   * 后台任务限额按会话独立计算，避免某个会话占满名额导致其他会话无法启动任务
   */
  private _countRunning(sessionId?: string): number {
    let count = 0
    for (const t of this.tasks.values()) {
      if (t.status === 'running' && t.sessionId === sessionId) count++
    }
    return count
  }

  /**
   * 获取任务输出：运行中任务返回内存缓存，已结束任务从输出文件读取
   * 任务结束后内存中的 output 会被清空（已落盘），由此释放内存
   */
  getTaskOutput(taskId: string): string {
    const record = this.tasks.get(taskId)
    if (!record) return ''
    if (record.output) return record.output
    try {
      return fs.readFileSync(record.filepath, 'utf8')
    } catch {
      return ''
    }
  }

  /**
   * 订阅任务的流式输出（UI 打开任务详情面板时调用）
   * 立即补发已有输出，后续增量实时推送
   */
  watchTask(taskId: string, onDelta: (delta: string) => void): () => void {
    if (!this.watchers.has(taskId)) {
      this.watchers.set(taskId, new Set())
    }
    this.watchers.get(taskId)!.add(onDelta)

    // 补发已有输出（运行中走内存，已结束从输出文件读取）
    const existing = this.getTaskOutput(taskId)
    if (existing) {
      onDelta(existing)
    }

    return () => {
      this.watchers.get(taskId)?.delete(onDelta)
    }
  }

  /**
   * 为 background=true 的命令 spawn 独立进程
   */
  spawnRunShellTask(
    command: string,
    toolUseId: string,
    agentContext: any,
  ): { taskId: string; filepath: string } {
    if (this._countRunning(agentContext?.sessionId) >= TaskManager.MAX_RUNNING_TASKS) {
      throw new Error(`Maximum number of running background tasks (${TaskManager.MAX_RUNNING_TASKS}) reached for this session. Stop or wait for existing tasks to complete before starting new ones.`)
    }
    ensureTaskDir()
    const taskId = crypto.randomBytes(4).toString('hex')
    const filepath = path.join(TASK_OUTPUT_DIR, `${taskId}.output`)

    // 初始化输出文件
    fs.writeFileSync(filepath, '')

    const record: TaskRecord = {
      taskId,
      sessionId: agentContext?.sessionId,
      type: 'RunShell',
      command,
      toolUseId,
      filepath,
      status: 'running',
      output: '',
      startTime: Date.now(),
    }
    this.tasks.set(taskId, record)

    const { bin, args } = getShellForSpawn()
    const childProcess = spawn(bin, [...args, command], {
      cwd: readInitialCwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(IS_WIN ? { windowsHide: true } : {}),
    })
    record._process = childProcess
    record.pid = childProcess.pid

    logInfo(`[TaskManager] spawnRunShellTask taskId=${taskId} pid=${childProcess.pid} command=${command}`)

    // emit task:start
    getEventBus().emit('task:start', { taskId, pid: childProcess.pid, command, filepath, status: record.status, type: 'RunShell' }, record.sessionId)

    const appendChunk = (chunk: string) => {
      record.output += chunk
      // 限制内存上限
      if (record.output.length > MAX_OUTPUT_BYTES) {
        record.output = record.output.slice(-MAX_OUTPUT_BYTES)
      }
      try {
        fs.appendFileSync(filepath, chunk)
      } catch (e) {
        logWarn(`[TaskManager] appendFileSync 失败: ${e}`)
      }
      this._notifyWatchers(taskId, chunk)
    }

    childProcess.stdout?.on('data', (data: Buffer) => appendChunk(data.toString()))
    childProcess.stderr?.on('data', (data: Buffer) => appendChunk(data.toString()))

    childProcess.on('exit', (code) => {
      const exitCode = code ?? 1
      logInfo(`[TaskManager] task ${taskId} exited with code ${exitCode}`)
      this._finishTask(record, exitCode)
    })

    childProcess.on('error', (error) => {
      logError(`[TaskManager] task ${taskId} process error: ${error}`)
      appendChunk(`\n[Process error: ${error.message}]`)
      this._finishTask(record, 1)
    })

    return { taskId, filepath }
  }

  /**
   * 接管超时的持久 shell 进程
   */
  takeoverTask(
    ctx: TimeoutTransferContext,
    command: string,
    toolUseId: string,
    agentContext: any,
  ): { taskId: string; filepath: string } {
    if (this._countRunning(agentContext?.sessionId) >= TaskManager.MAX_RUNNING_TASKS) {
      killProcess(ctx.shellProcess)
      throw new Error(`Maximum number of running background tasks (${TaskManager.MAX_RUNNING_TASKS}) reached for this session. Cannot transfer timed-out command to background.`)
    }
    ensureTaskDir()
    const taskId = crypto.randomBytes(4).toString('hex')
    const filepath = path.join(TASK_OUTPUT_DIR, `${taskId}.output`)

    // 将超时前的部分输出写入文件
    fs.writeFileSync(filepath, ctx.partialOutput)

    const record: TaskRecord = {
      taskId,
      sessionId: agentContext?.sessionId,
      type: 'RunShell',
      command,
      toolUseId,
      filepath,
      status: 'running',
      output: ctx.partialOutput,
      _shellProcess: ctx.shellProcess,
      startTime: Date.now(),
    }
    this.tasks.set(taskId, record)

    const takeoverPid = ctx.shellProcess.pid
    record.pid = takeoverPid

    logInfo(`[TaskManager] takeoverTask taskId=${taskId} pid=${takeoverPid} command=${command}`)
    getEventBus().emit('task:start', { taskId, pid: takeoverPid, command, filepath, status: record.status, type: 'RunShell' }, record.sessionId)

    // 记录已读取的文件偏移量
    let stdoutOffset = ctx.partialOutput.length
    let stderrOffset = 0

    const pollTimer = setInterval(() => {
      try {
        // 检查 shell 进程是否已退出（异常退出）
        const shellExited = ctx.shellProcess.exitCode !== null

        // 读取 stdout 增量
        if (fs.existsSync(ctx.stdoutFile)) {
          const content = fs.readFileSync(ctx.stdoutFile).toString('utf8')
          if (content.length > stdoutOffset) {
            const chunk = content.slice(stdoutOffset)
            stdoutOffset = content.length
            record.output += chunk
            if (record.output.length > MAX_OUTPUT_BYTES) {
              record.output = record.output.slice(-MAX_OUTPUT_BYTES)
            }
            try {
              fs.appendFileSync(filepath, chunk)
            } catch {}
            this._notifyWatchers(taskId, chunk)
          }
        }

        // 读取 stderr 增量
        if (fs.existsSync(ctx.stderrFile)) {
          const content = fs.readFileSync(ctx.stderrFile).toString('utf8')
          if (content.length > stderrOffset) {
            const chunk = content.slice(stderrOffset)
            stderrOffset = content.length
            record.output += chunk
            if (record.output.length > MAX_OUTPUT_BYTES) {
              record.output = record.output.slice(-MAX_OUTPUT_BYTES)
            }
            try {
              fs.appendFileSync(filepath, chunk)
            } catch {}
            this._notifyWatchers(taskId, chunk)
          }
        }

        // 检查 statusFile：命令正常完成
        if (fs.existsSync(ctx.statusFile) && fs.statSync(ctx.statusFile).size > 0) {
          const exitCodeStr = fs.readFileSync(ctx.statusFile, 'utf8').trim()
          const exitCode = Number(exitCodeStr) || 0

          // 先读完最终输出（防止 shell exit handler 删文件后读到空）
          if (fs.existsSync(ctx.stdoutFile)) {
            const content = fs.readFileSync(ctx.stdoutFile).toString('utf8')
            if (content.length > stdoutOffset) {
              const chunk = content.slice(stdoutOffset)
              record.output += chunk
              try {
                fs.appendFileSync(filepath, chunk)
              } catch {}
            }
          }
          if (fs.existsSync(ctx.stderrFile)) {
            const content = fs.readFileSync(ctx.stderrFile).toString('utf8')
            if (content.length > stderrOffset) {
              const chunk = content.slice(stderrOffset)
              record.output += chunk
              try {
                fs.appendFileSync(filepath, chunk)
              } catch {}
            }
          }

          clearInterval(pollTimer)
          record._pollTimer = undefined

          // kill 旧 shell
          killProcess(ctx.shellProcess)

          this._finishTask(record, exitCode)
          return
        }

        // shell 异常退出且没有 statusFile → 失败
        if (shellExited) {
          clearInterval(pollTimer)
          record._pollTimer = undefined
          this._finishTask(record, ctx.shellProcess.exitCode ?? 1)
          return
        }
      } catch (error) {
        logWarn(`[TaskManager] takeoverTask poll error: ${error}`)
      }
    }, 200)

    record._pollTimer = pollTimer

    return { taskId, filepath }
  }

  /**
   * 注册前台 Agent 任务（不启动独立执行，仅创建 record 用于转后台）
   */
  registerForegroundAgent(
    taskId: string,
    sessionId: string,
    description: string,
    toolUseId: string,
    abortController: AbortController,
    unlinkAbort: () => void,
    agentType?: string,
  ): void {
    ensureTaskDir()
    const filepath = path.join(TASK_OUTPUT_DIR, `${taskId}.output`)
    fs.writeFileSync(filepath, '')

    const record: TaskRecord = {
      taskId,
      sessionId,
      type: 'SubAgent',
      command: description,
      toolUseId,
      filepath,
      status: 'running',
      output: '',
      foreground: true,
      _abortController: abortController,
      _unlinkAbort: unlinkAbort,
      startTime: Date.now(),
      agentType,
    }
    this.tasks.set(taskId, record)
    logInfo(`[TaskManager] registerForegroundAgent taskId=${taskId} description=${description}`)
  }

  /**
   * 设置前台 agent 的转后台 resolve 回调
   */
  setTransferResolve(taskId: string, resolve: () => void): void {
    const record = this.tasks.get(taskId)
    if (record) {
      record._transferResolve = resolve
    }
  }

  /**
   * 将指定前台 agent 转为后台运行
   * 1. 解除子AC与主AC的联动
   * 2. resolve transferSignal，让 Agent.ts 的 Promise.race 立刻返回
   * 3. 标记 foreground=false
   */
  transferToBackground(taskId: string): boolean {
    const record = this.tasks.get(taskId)
    if (!record || !record.foreground || record.status !== 'running') {
      return false
    }

    // 解除与主AC的联动
    if (record._unlinkAbort) {
      record._unlinkAbort()
      record._unlinkAbort = undefined
    }

    // 标记为后台
    record.foreground = false

    // 触发 transferSignal，让 Promise.race 立刻返回
    if (record._transferResolve) {
      record._transferResolve()
      record._transferResolve = undefined
    }

    logInfo(`[TaskManager] transferToBackground taskId=${taskId}`)
    getEventBus().emit('task:transfer', {
      taskId,
      command: record.command,
      filepath: record.filepath,
      status: record.status,
      type: record.type as 'RunShell' | 'SubAgent',
      agentType: record.agentType,
    }, record.sessionId)

    return true
  }

  /**
   * 将所有前台 agent 转为后台（可按会话过滤）
   */
  transferAllForeground(sessionId?: string): string[] {
    const transferred: string[] = []
    for (const record of this.tasks.values()) {
      if (sessionId && record.sessionId !== sessionId) continue
      if (record.foreground && record.status === 'running') {
        if (this.transferToBackground(record.taskId)) {
          transferred.push(record.taskId)
        }
      }
    }
    return transferred
  }

  /**
   * 完结 Agent 任务记录（供 Agent.ts 在前台/转后台完成时调用）
   */
  finalizeTask(
    taskId: string,
    exitCode: number,
    output?: string,
    usage?: { totalTokens: number; toolUses: number; durationMs: number },
  ): void {
    const record = this.tasks.get(taskId)
    if (!record || record.status !== 'running') return
    if (output !== undefined) record.output = output
    if (usage) record.usage = usage
    this._finishTask(record, exitCode)
  }

  /**
   * 为后台 Agent 创建任务记录并异步执行
   */
  spawnAgentTask(
    taskId: string,
    sessionId: string,
    description: string,
    toolUseId: string,
    executeFn: (abortController: AbortController) => Promise<string | { result: string; usage?: { totalTokens: number; toolUses: number; durationMs: number } }>,
    agentType?: string,
  ): { taskId: string; filepath: string } {
    if (this._countRunning(sessionId) >= TaskManager.MAX_RUNNING_TASKS) {
      throw new Error(`Maximum number of running background tasks (${TaskManager.MAX_RUNNING_TASKS}) reached for this session. Stop or wait for existing tasks to complete before starting new ones.`)
    }
    ensureTaskDir()
    const filepath = path.join(TASK_OUTPUT_DIR, `${taskId}.output`)
    fs.writeFileSync(filepath, '')

    const abortController = new AbortController()

    const record: TaskRecord = {
      taskId,
      sessionId,
      type: 'SubAgent',
      command: description,
      toolUseId,
      filepath,
      status: 'running',
      output: '',
      _abortController: abortController,
      startTime: Date.now(),
      agentType,
    }
    this.tasks.set(taskId, record)

    logInfo(`[TaskManager] spawnAgentTask taskId=${taskId} description=${description}`)
    getEventBus().emit('task:start', { taskId, command: description, filepath: '', status: record.status, type: 'SubAgent', agentType }, sessionId)

    const promise = executeFn(abortController).then((raw) => {
      const result = typeof raw === 'string' ? raw : raw.result
      const usage = typeof raw === 'string' ? undefined : raw.usage
      record.output = result
      if (usage) record.usage = usage
      try { fs.writeFileSync(filepath, result) } catch (e) {
        logWarn(`[TaskManager] writeFileSync failed for agent task: ${e}`)
      }
      this._finishTask(record, 0)
    }).catch((error) => {
      const isAborted = abortController.signal.aborted
      const msg = isAborted
        ? '[Agent interrupted]'
        : `[Agent error: ${error instanceof Error ? error.message : String(error)}]`
      if (!record.output) record.output = msg
      try { fs.appendFileSync(filepath, msg) } catch {}
      this._finishTask(record, isAborted ? 0 : 1)
    })

    record._promise = promise

    return { taskId, filepath }
  }

  /**
   * 停止所有正在运行的任务（可按会话过滤）
   */
  stopAllTasks(sessionId?: string): number {
    const running = this.getRunningTasks()
    let count = 0
    for (const record of running) {
      if (sessionId && record.sessionId !== sessionId) continue
      if (this.stopTask(record.taskId)) {
        count++
      }
    }
    return count
  }

  /**
   * 停止指定任务
   */
  stopTask(taskId: string): boolean {
    const record = this.tasks.get(taskId)
    if (!record) return false

    // 清理定时器
    if (record._pollTimer) {
      clearInterval(record._pollTimer)
      record._pollTimer = undefined
    }

    // kill 进程 / abort agent
    let killed = false
    if (record._process) {
      killed = killProcess(record._process)
    }
    if (record._shellProcess) {
      killed = killProcess(record._shellProcess) || killed
    }
    if (record._abortController) {
      record._abortController.abort()
      killed = true
    }

    if (!killed) {
      logWarn(`[TaskManager] stopTask taskId=${taskId} kill failed`)
      return false
    }

    record.status = 'killed'
    record.endTime = Date.now()
    logInfo(`[TaskManager] stopTask taskId=${taskId} pid=${record.pid}`)

    // 前台 SubAgent 不发 task:end / 不 notify（结果由 Agent.ts yield 返回）
    if (!record.foreground) {
      getEventBus().emit('task:end', {
        taskId,
        status: 'killed',
        summary: this._formatTaskSummary(record, 'killed'),
      }, record.sessionId)
      if (record.type === 'SubAgent') {
        this._notify(record)
      }
    }

    // 输出已落盘到 filepath，清空内存缓存释放内存
    record.output = ''
    this._pruneFinishedTasks(record.sessionId)
    return true
  }

  /**
   * 等待任务完成（Promise）
   */
  waitForTask(taskId: string, timeout: number = 30000, onChunk?: (delta: string) => void, abortSignal?: AbortSignal): Promise<TaskRecord> {
    return new Promise((resolve) => {
      const record = this.tasks.get(taskId)
      if (!record) {
        resolve({ taskId, type: 'RunShell', command: '', toolUseId: '', filepath: '', status: 'failed', output: '', startTime: 0 })
        return
      }

      if (record.status !== 'running') {
        resolve(record)
        return
      }

      let unwatch: (() => void) | undefined

      if (onChunk) {
        unwatch = this.watchTask(taskId, onChunk)
      }

      const cleanup = () => {
        if (unwatch) unwatch()
        clearTimeout(timer)
        getEventBus().off('task:end', taskEventListener)
      }

      const timer = setTimeout(() => {
        cleanup()
        resolve(record)
      }, timeout)

      const taskEventListener = (data: any) => {
        if (data.taskId === taskId) {
          cleanup()
          resolve(record)
        }
      }

      getEventBus().on('task:end', taskEventListener)

      // 中断支持：停止等待，不影响后台任务本身
      if (abortSignal) {
        if (abortSignal.aborted) {
          cleanup()
          resolve(record)
          return
        }
        abortSignal.addEventListener('abort', () => {
          cleanup()
          resolve(record)
        }, { once: true })
      }
    })
  }

  /**
   * 清理指定会话的后台任务（会话级 dispose）
   */
  disposeSession(sessionId: string): void {
    for (const record of Array.from(this.tasks.values())) {
      if (record.sessionId !== sessionId) continue
      if (record.status === 'running') {
        this.stopTask(record.taskId)
      }
      this.tasks.delete(record.taskId)
      this.watchers.delete(record.taskId)
    }
  }

  /**
   * 清理所有资源
   */
  dispose(): void {
    for (const record of this.tasks.values()) {
      if (record.status !== 'running') continue
      try {
        if (record._pollTimer) {
          clearInterval(record._pollTimer)
          record._pollTimer = undefined
        }
        let killed = false
        if (record._process) {
          killed = killProcess(record._process)
        }
        if (record._shellProcess) {
          killed = killProcess(record._shellProcess) || killed
        }
        if (record._abortController) {
          record._abortController.abort()
          killed = true
        }
        if (!killed) {
          logWarn(`[TaskManager] dispose: kill failed for taskId=${record.taskId} pid=${record.pid}`)
        }
        record.status = 'killed'
        // 前台 SubAgent 不发 task:end（与 task:start 保持对称）
        if (!record.foreground) {
          getEventBus().emit('task:end', {
            taskId: record.taskId,
            status: 'killed',
            summary: this._formatTaskSummary(record, 'killed'),
          }, record.sessionId)
        }
      } catch (error) {
        logError(`[TaskManager] dispose: error cleaning up taskId=${record.taskId}: ${error}`)
        record.status = 'killed'
      }
    }
    this.tasks.clear()
    this.watchers.clear()
  }

  private _notifyWatchers(taskId: string, delta: string) {
    const cbs = this.watchers.get(taskId)
    if (!cbs?.size) return
    cbs.forEach(cb => cb(delta))
  }

  private _formatTaskSummary(record: TaskRecord, status: string): string {
    const cmd = record.command.length > 50
      ? record.command.slice(0, 50) + '...'
      : record.command
    return `${record.type} "${cmd}" ${status}`
  }

  private _finishTask(record: TaskRecord, exitCode: number) {
    if (record.status !== 'running') return

    record.status = exitCode === 0 ? 'completed' : 'failed'
    record.exitCode = exitCode
    record.endTime = Date.now()

    // 清理 watchers
    this.watchers.delete(record.taskId)

    // 前台 SubAgent 不发 task:end（与 task:start 保持对称，结果由 Agent.ts yield 返回）
    // 只有后台任务（包括转后台的）才发事件 + notify
    if (!record.foreground) {
      getEventBus().emit('task:end', {
        taskId: record.taskId,
        status: record.status,
        summary: this._formatTaskSummary(record, record.status),
      }, record.sessionId)
      this._notify(record)
    }
    // 输出已落盘到 filepath，清空内存缓存释放内存（后续读取走 getTaskOutput → 文件）
    record.output = ''
    this._pruneFinishedTasks(record.sessionId)
  }

  /**
   * 清理已结束的任务，按会话独立保留最新的 MAX_FINISHED_TASKS 个
   * 按 sessionId 分组裁剪，避免某个会话频繁产出任务挤掉其他会话的历史记录
   */
  private _pruneFinishedTasks(sessionId?: string) {
    const finished = Array.from(this.tasks.values())
      .filter(t => t.status !== 'running' && t.sessionId === sessionId)
    if (finished.length <= TaskManager.MAX_FINISHED_TASKS) return
    const toRemove = finished.slice(0, finished.length - TaskManager.MAX_FINISHED_TASKS)
    for (const t of toRemove) {
      this.tasks.delete(t.taskId)
      this.watchers.delete(t.taskId)
    }
  }

  private _notify(record: TaskRecord) {
    const cb = record.sessionId ? this.notifyRegistry.get(record.sessionId) : undefined
    if (!cb) return
    let msg: string
    if (record.type === 'SubAgent') {
      const usageLine = record.usage
        ? `\n- tokens: ${record.usage.totalTokens}, tool_uses: ${record.usage.toolUses}, duration: ${record.usage.durationMs}ms`
        : ''
      msg = `[task-notification] task_id=${record.taskId} tool_use_id=${record.toolUseId} status=${record.status}
- summary: Agent "${record.command}" ${record.status}${usageLine}
- result:
${record.output}`
    } else {
      msg = `[task-notification] task_id=${record.taskId} tool_use_id=${record.toolUseId} status=${record.status}
- summary: Background shell command ${record.status} (exit code ${record.exitCode ?? 'N/A'})
- output_file: ${record.filepath}
To retrieve the result, read the output file: ${record.filepath}`
    }
    cb(msg)
  }
}

// 单例
let instance: TaskManager | null = null

export function getTaskManager(): TaskManager {
  if (!instance) {
    instance = new TaskManager()
  }
  return instance
}

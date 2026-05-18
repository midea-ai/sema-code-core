/**
 * Cron 定时任务管理器
 */
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { CronTask, CronTaskFile } from '../types/cron'
import { calcNextFireAts, describeCronExpression } from '../util/cron'
import { findJsonObjectLineRange } from '../util/file'
import { getConfManager } from './ConfManager'
import { getStateManager } from './StateManager'
import { getEventBus } from '../events/EventSystem'
import { logInfo, logWarn } from '../util/log'
import { SessionNotifyRegistry, NotifyCallback } from '../util/notifyRegistry'

export const CRON_TASKS_FILE = '.sema/scheduled_tasks.json'

export class CronManager {
  private tasks = new Map<string, CronTask>()
  private timer: ReturnType<typeof setInterval> | null = null
  /** 按 sessionId 注册的通知回调 */
  private notifyRegistry = new SessionNotifyRegistry()
  private loadingPromise: Promise<void> | null = null
  private loaded = false

  private tasksFilePath: string      // .sema/scheduled_tasks.json
  private settingsFilePath: string   // .sema/settings.json

  static MAX_TASKS = 20
  static TICK_INTERVAL = 60_000 // 60秒，与 cron 最小粒度一致
  static RECURRING_EXPIRE_MS = 10 * 24 * 60 * 60 * 1000 // 循环任务10天过期

  constructor() {
    const workingDir = getConfManager().getCoreConfig()?.workingDir || process.cwd()
    const semaDir = path.join(workingDir, '.sema')
    this.tasksFilePath = path.join(workingDir, CRON_TASKS_FILE)
    this.settingsFilePath = path.join(semaDir, 'settings.json')

    // 后台静默加载持久化的定时任务
    this.loadingPromise = this.loadDurableTasks()
      .catch(err => {
        logWarn(`[CronManager] 后台加载持久化定时任务失败: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => { this.loadingPromise = null })
  }

  // ============ 回调 ============

  setNotifyCallback(sessionId: string, cb: NotifyCallback): void {
    this.notifyRegistry.set(sessionId, cb)
  }

  removeNotifyCallback(sessionId: string): void {
    this.notifyRegistry.remove(sessionId)
  }

  // ============ CRUD ============

  createTask(schedule: string, task: string, repeat: boolean, persist: boolean, sessionId?: string): string {
    if (this.tasks.size >= CronManager.MAX_TASKS) {
      throw new Error(`Maximum number of cron tasks (${CronManager.MAX_TASKS}) reached`)
    }

    const id = crypto.randomBytes(4).toString('hex')
    const now = Date.now()
    const nextFireAt = calcNextFireAts(schedule, now, repeat ? 4 : 1)
    if (nextFireAt.length === 0) {
      throw new Error(`Cannot calculate next fire time for cron expression: ${schedule}`)
    }

    const cronTask: CronTask = {
      id,
      sessionId,
      schedule,
      task,
      repeat,
      persist,
      status: true,
      filePath: persist ? this.tasksFilePath : undefined,
      createdAt: now,
      describeCronExpression: describeCronExpression(schedule),
      activatedAt: now,
      nextFireAt,
    }

    this.tasks.set(id, cronTask)

    if (persist) {
      this.persistToFile()
    }

    this.ensureRunning()
    this.emitUpdate()
    logInfo(`[CronManager] Task created: ${id}, schedule: ${schedule}, repeat: ${repeat}, persist: ${persist}`)
    return id
  }

  deleteTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false

    this.tasks.delete(id)
    if (task.persist) {
      this.persistToFile()
    }

    // 清理 settings.json 中的 disabled 记录
    const settings = this.readSemaSettings()
    if (settings.disabledCronTasks?.includes(id)) {
      settings.disabledCronTasks = settings.disabledCronTasks.filter((tid: string) => tid !== id)
      this.writeSemaSettings(settings)
    }

    if (this.tasks.size === 0) {
      this.stop()
    }

    this.emitUpdate()
    logInfo(`[CronManager] Task deleted: ${id}`)
    return true
  }

  enableTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false

    task.status = true
    const settings = this.readSemaSettings()
    if (settings.disabledCronTasks) {
      settings.disabledCronTasks = settings.disabledCronTasks.filter((tid: string) => tid !== id)
    }
    this.writeSemaSettings(settings)

    this.ensureRunning()
    this.emitUpdate()
    logInfo(`[CronManager] Task ${id} enabled`)
    return true
  }

  disableTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false

    task.status = false
    const settings = this.readSemaSettings()
    if (!settings.disabledCronTasks) settings.disabledCronTasks = []
    if (!settings.disabledCronTasks.includes(id)) {
      settings.disabledCronTasks.push(id)
    }
    this.writeSemaSettings(settings)

    if (!this.hasActiveTasks()) {
      this.stop()
    }

    this.emitUpdate()
    logInfo(`[CronManager] Task ${id} disabled`)
    return true
  }

  isTaskEnabled(id: string): boolean {
    const task = this.tasks.get(id)
    return task?.status ?? false
  }

  findTask(id: string): CronTask | undefined {
    return this.tasks.get(id)
  }

  getTask(id: string): CronTask | undefined {
    return this.tasks.get(id)
  }

  listTasks(): CronTask[] {
    return Array.from(this.tasks.values())
  }

  /**
   * 获取任务列表（有缓存则直接返回，否则等待后台加载完成）
   */
  async getTaskList(): Promise<CronTask[]> {
    if (this.loaded) {
      return this.listTasks()
    }
    if (this.loadingPromise) {
      await this.loadingPromise
    }
    return this.listTasks()
  }

  // ============ settings.json 读写 ============

  private readSemaSettings(): Record<string, any> {
    try {
      if (!fs.existsSync(this.settingsFilePath)) return {}
      return JSON.parse(fs.readFileSync(this.settingsFilePath, 'utf-8'))
    } catch {
      return {}
    }
  }

  private writeSemaSettings(data: Record<string, any>): void {
    try {
      const dir = path.dirname(this.settingsFilePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.settingsFilePath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      logWarn(`[CronManager] Failed to write settings: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ============ 持久化 ============

  private persistToFile(): void {
    try {
      const dir = path.dirname(this.tasksFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      const persistedTasks = Array.from(this.tasks.values()).filter(t => t.persist)
      const data: CronTaskFile = {
        tasks: persistedTasks.map(t => ({
          id: t.id,
          schedule: t.schedule,
          task: t.task,
          repeat: t.repeat,
          createdAt: t.createdAt,
          lastFiredAt: t.lastFiredAt,
        })),
      }

      const json = JSON.stringify(data, null, 2)
      fs.writeFileSync(this.tasksFilePath, json, 'utf-8')

      // 回填每个持久化任务的 filePath（文件名:起始行-结束行）
      for (const task of persistedTasks) {
        const range = findJsonObjectLineRange(json, `"id": "${task.id}"`)
        task.filePath = range ? `${this.tasksFilePath}:${range[0]}-${range[1]}` : this.tasksFilePath
      }
    } catch (err) {
      logWarn(`[CronManager] Failed to persist tasks: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private loadFromFile(): number {
    if (!fs.existsSync(this.tasksFilePath)) return 0

    const raw = fs.readFileSync(this.tasksFilePath, 'utf-8')
    const data: CronTaskFile = JSON.parse(raw)
    if (!data.tasks || !Array.isArray(data.tasks)) return 0

    const now = Date.now()
    let loaded = 0
    const disabledSet = new Set<string>(this.readSemaSettings().disabledCronTasks ?? [])

    let hasExpired = false

    for (const t of data.tasks) {
      if (this.tasks.has(t.id)) continue

      // 一次性任务：原定首次触发时间已过 → 不补发，直接丢弃
      if (!t.repeat) {
        const expectedFire = calcNextFireAts(t.schedule, t.createdAt, 1)[0]
        if (expectedFire == null || expectedFire <= now || t.lastFiredAt != null) {
          hasExpired = true
          continue
        }
        const range = findJsonObjectLineRange(raw, `"id": "${t.id}"`)
        const filePath = range ? `${this.tasksFilePath}:${range[0]}-${range[1]}` : this.tasksFilePath
        const cronTask: CronTask = { ...t, persist: true, filePath, status: !disabledSet.has(t.id), describeCronExpression: describeCronExpression(t.schedule), activatedAt: now, nextFireAt: [expectedFire] }
        this.tasks.set(cronTask.id, cronTask)
        loaded++
        continue
      }

      // 循环任务：从 now 开始算未来 4 次
      const nextFireAt = calcNextFireAts(t.schedule, now, 4)
      if (nextFireAt.length === 0) continue

      const range = findJsonObjectLineRange(raw, `"id": "${t.id}"`)
      const filePath = range ? `${this.tasksFilePath}:${range[0]}-${range[1]}` : this.tasksFilePath
      const cronTask: CronTask = { ...t, persist: true, filePath, status: !disabledSet.has(t.id), describeCronExpression: describeCronExpression(t.schedule), activatedAt: now, nextFireAt }

      this.tasks.set(cronTask.id, cronTask)
      loaded++
    }

    if (hasExpired) {
      this.persistToFile()
    }

    return loaded
  }

  /**
   * 后台加载持久化任务（仅在构造时调用一次）
   */
  private async loadDurableTasks(): Promise<void> {
    try {
      const loaded = this.loadFromFile()
      if (this.tasks.size > 0) {
        this.ensureRunning()
      }
      logInfo(`[CronManager] Loaded durable tasks: ${loaded}`)
    } catch (err) {
      logWarn(`[CronManager] Failed to load tasks: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.loaded = true
    }
  }

  /**
   * 清空非持久化任务（会话关闭时调用）
   * 传入 sessionId 时只清理该会话创建的非持久任务
   */
  clearNonDurableTasks(sessionId?: string): void {
    for (const [id, task] of this.tasks) {
      if (task.persist) continue
      if (sessionId && task.sessionId !== sessionId) continue
      this.tasks.delete(id)
    }

    if (this.tasks.size === 0) {
      this.stop()
    }

    this.emitUpdate()
    logInfo(`[CronManager] Cleared non-persisted tasks`)
  }

  // ============ 调度 ============

  private ensureRunning(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), CronManager.TICK_INTERVAL)
    if (this.timer.unref) {
      this.timer.unref()
    }
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * 解析定时任务应注入的目标会话（来源优先，活跃兜底）
   * 1. 任务有 sessionId 且该会话仍注册了回调 → 用来源会话
   * 2. 否则（持久化任务/来源会话已关闭）→ 投 UI 当前活跃会话
   * 3. 再否则 → 取任意一个已注册会话兜底
   */
  private resolveTarget(task: CronTask): { sessionId: string; cb: NotifyCallback } | null {
    if (task.sessionId) {
      const cb = this.notifyRegistry.get(task.sessionId)
      if (cb) return { sessionId: task.sessionId, cb }
    }

    const activeId = getStateManager().getActiveSessionId()
    if (activeId) {
      const cb = this.notifyRegistry.get(activeId)
      if (cb) return { sessionId: activeId, cb }
    }

    return this.notifyRegistry.getAny()
  }

  private tick(): void {
    const now = Date.now()
    const toDelete: string[] = []

    for (const task of this.tasks.values()) {
      // 循环任务本轮调度超过10天，停止调度（不删持久化文件，下次启动重新计）
      if (task.repeat && now - task.activatedAt >= CronManager.RECURRING_EXPIRE_MS) {
        task.status = false
        logInfo(`[CronManager] Recurring task ${task.id} expired after 10 days in this session`)
        continue
      }

      if (!task.status) continue
      if (task.nextFireAt.length === 0 || task.nextFireAt[0] > now) continue
      if (task.lastFiredAt != null && task.lastFiredAt >= task.nextFireAt[0]) continue

      // 解析目标会话；无目标则本轮跳过，下轮重试
      // 会话忙时由 processUserInput 自动入队，无需在此判断空闲
      const target = this.resolveTarget(task)
      if (!target) continue

      this.fire(task, target.cb)
      task.lastFiredAt = now

      if (task.repeat) {
        const next = calcNextFireAts(task.schedule, now, 4)
        if (next.length > 0) {
          task.nextFireAt = next
        }
        if (task.persist) {
          this.persistToFile()
        }
      } else {
        toDelete.push(task.id)
      }
    }

    for (const id of toDelete) {
      this.tasks.delete(id)
    }
    if (toDelete.length > 0) {
      this.persistToFile()
      this.emitUpdate()
    }

    if (this.tasks.size === 0 || !this.hasActiveTasks()) {
      this.stop()
    }
  }

  private emitUpdate(): void {
    getEventBus().emit('cron:update', {})
  }

  private hasActiveTasks(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status) return true
    }
    return false
  }

  private fire(task: CronTask, cb: (msg: string) => void): void {
    const msg = `[cron-notification] task_id=${task.id} schedule=${task.schedule} repeat=${task.repeat}
- schedule: ${task.describeCronExpression}
- task: ${task.task}
The above scheduled task has been triggered. Please execute the prompt.`

    logInfo(`[CronManager] Firing task ${task.id}: ${task.task.slice(0, 100)}`)
    cb(msg)
  }

  // ============ 生命周期 ============

  dispose(): void {
    this.stop()
    this.tasks.clear()
  }
}

// 单例
let instance: CronManager | null = null

export function getCronManager(): CronManager {
  if (!instance) {
    instance = new CronManager()
  }
  return instance
}

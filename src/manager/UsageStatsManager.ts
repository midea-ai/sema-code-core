/**
 * 使用统计管理器
 * 只记计数与 id（模型名 / 工具名 / skill 名 / sessionId），不存任何对话内容、路径、入参。
 * usageProduct 未配置时完全不工作：不建目录、不注册监听、不起定时器。
 *
 * 落盘：内存只持"上次落盘后的增量"账本，账本从空变非空后 USAGE_STATS_FLUSH_INTERVAL 到点
 * 序列化成一行追加到 <semaRoot>/stats/<product>/YYYY-MM-DD.jsonl；dispose 时同步落盘。
 * 目录：每个产品一个子目录，product 须为字母数字 ._- 组成的简单名字；清除某产品即删除其目录。
 * 压缩：初始化时把早于今天且多于一行的文件合并成一行。
 */
import * as fs from 'fs'
import * as path from 'path'
import { getEventBus } from '../events/EventSystem'
import { ToolExecutionCompleteData, ToolExecutionErrorData } from '../events/types'
import { STATS_DIR_PATH, USAGE_STATS_FLUSH_INTERVAL } from '../conf/config'
import { getSemaRootDir } from '../util/savePath'
import { getDayTimeString } from '../util/time'
import { TOOL_NAME_SKILL } from '../prompt/tool'
import { logError } from '../util/log'

// ==================== 对外类型 ====================

export interface UsageTokens {
  hit: number     // 缓存命中的输入 token
  miss: number    // 未命中缓存的输入 token
  output: number  // 输出 token
}

export interface UsageModelStat {
  requests: number
  hitKnown: boolean   // 服务商是否返回过缓存命中数；false 时 hit 恒为 0，miss 即总输入
  tokens: UsageTokens
}

export interface UsageToolStat {
  calls: number
  errors: number
}

export interface UsageSkillStat {
  calls: number
  lastAt: number   // 最近一次调用时间戳
}

export interface UsageDayData {
  requests: number
  tokens: UsageTokens
  models: Record<string, UsageModelStat>
  tools: Record<string, UsageToolStat>
  skills: Record<string, UsageSkillStat>
  sessions: string[]   // 当天去重后的会话 id
}

export interface UsageTotals {
  requests: number
  tokens: UsageTokens
  sessions: number   // 全部文件 sessionId 去重数
  days: number       // 有文件的日期数
}

export interface UsageStatsData {
  since: string | null   // 最早文件日期 'YYYY-MM-DD'，无数据为 null
  updatedAt: number
  totals: UsageTotals
  days: Record<string, UsageDayData>   // 只含近 366 天且有文件的日期
}

export interface RecordLlmParams {
  model: string
  inputTokens: number       // 总输入（含缓存读写）
  outputTokens: number
  cacheReadTokens?: number  // 服务商未返回时缺失
  sessionId?: string
}

// ==================== 内部类型 ====================

/** 落盘的一行（产品由所在目录决定，行内不存） */
interface UsageLine extends UsageDayData {
  t: number
}

/** 内存账本：sessions 用 Set 去重 */
interface Ledger extends Omit<UsageDayData, 'sessions'> {
  sessions: Set<string>
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const DAYS_WINDOW = 366
/** 产品标识用作目录名：只允许字母数字 ._-，且不能以 . 开头（排除 . / .. / 隐藏目录 / 路径分隔符） */
const PRODUCT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function isValidProduct(product: string | undefined): product is string {
  return !!product && PRODUCT_RE.test(product)
}

function emptyTokens(): UsageTokens {
  return { hit: 0, miss: 0, output: 0 }
}

function emptyLedger(): Ledger {
  return { requests: 0, tokens: emptyTokens(), models: {}, tools: {}, skills: {}, sessions: new Set() }
}

function addTokens(target: UsageTokens, src: UsageTokens): void {
  target.hit += src.hit || 0
  target.miss += src.miss || 0
  target.output += src.output || 0
}

/** 把一行数据合并进账本（数值相加、sessions 去重、lastAt 取大、hitKnown 取或） */
function mergeInto(target: Ledger, src: UsageDayData): void {
  target.requests += src.requests || 0
  addTokens(target.tokens, src.tokens || emptyTokens())
  for (const [name, m] of Object.entries(src.models || {})) {
    const cur = target.models[name] ?? (target.models[name] = { requests: 0, hitKnown: false, tokens: emptyTokens() })
    cur.requests += m.requests || 0
    cur.hitKnown = cur.hitKnown || !!m.hitKnown
    addTokens(cur.tokens, m.tokens || emptyTokens())
  }
  for (const [name, t] of Object.entries(src.tools || {})) {
    const cur = target.tools[name] ?? (target.tools[name] = { calls: 0, errors: 0 })
    cur.calls += t.calls || 0
    cur.errors += t.errors || 0
  }
  for (const [name, s] of Object.entries(src.skills || {})) {
    const cur = target.skills[name] ?? (target.skills[name] = { calls: 0, lastAt: 0 })
    cur.calls += s.calls || 0
    cur.lastAt = Math.max(cur.lastAt, s.lastAt || 0)
  }
  for (const id of src.sessions || []) target.sessions.add(id)
}

function ledgerToDay(ledger: Ledger): UsageDayData {
  return {
    requests: ledger.requests,
    tokens: ledger.tokens,
    models: ledger.models,
    tools: ledger.tools,
    skills: ledger.skills,
    sessions: [...ledger.sessions],
  }
}

function parseLines(content: string): UsageLine[] {
  const lines: UsageLine[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object' && typeof obj.t === 'number') lines.push(obj as UsageLine)
    } catch (e) {
      logError(`使用统计行解析失败，已跳过: ${e}`)
    }
  }
  return lines
}

function isENOENT(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as NodeJS.ErrnoException).code === 'ENOENT'
}

// ==================== 管理器 ====================

export class UsageStatsManager {
  private product = ''
  private ledger: Ledger = emptyLedger()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private listeners: Array<{ event: string; fn: Function }> = []

  // ============ 生命周期 ============

  init(product: string | undefined): void {
    if (!product) return
    if (!isValidProduct(product)) {
      logError(`使用统计已禁用：usageProduct "${product}" 不是合法目录名（只允许字母数字 ._-，不能以 . 开头）`)
      return
    }
    this.product = product
    const onComplete = (data: ToolExecutionCompleteData) => this.recordTool(data.toolName, data.title, false)
    const onError = (data: ToolExecutionErrorData) => this.recordTool(data.toolName, data.title, true)
    const bus = getEventBus()
    bus.on('tool:execution:complete', onComplete, null)
    bus.on('tool:execution:error', onError, null)
    this.listeners = [
      { event: 'tool:execution:complete', fn: onComplete },
      { event: 'tool:execution:error', fn: onError },
    ]
    this.compactOldFiles().catch(e => logError(`使用统计压缩失败: ${e}`))
  }

  dispose(): void {
    if (!this.product) return
    this.flushSync()
    const bus = getEventBus()
    this.listeners.forEach(({ event, fn }) => bus.off(event, fn as any))
    this.listeners = []
    this.product = ''
  }

  // ============ 采集（热路径只做内存加法） ============

  recordLlm(params: RecordLlmParams): void {
    if (!this.product) return
    const { model, inputTokens, outputTokens, cacheReadTokens, sessionId } = params
    const hit = cacheReadTokens ?? 0
    const delta: UsageTokens = { hit, miss: inputTokens - hit, output: outputTokens }

    this.ledger.requests += 1
    addTokens(this.ledger.tokens, delta)
    const m = this.ledger.models[model] ?? (this.ledger.models[model] = { requests: 0, hitKnown: false, tokens: emptyTokens() })
    m.requests += 1
    if (cacheReadTokens !== undefined) m.hitKnown = true
    addTokens(m.tokens, delta)
    if (sessionId) this.ledger.sessions.add(sessionId)
    this.scheduleFlush()
  }

  private recordTool(toolName: string, title: string, isError: boolean): void {
    if (!this.product) return
    const t = this.ledger.tools[toolName] ?? (this.ledger.tools[toolName] = { calls: 0, errors: 0 })
    t.calls += 1
    if (isError) t.errors += 1
    if (toolName === TOOL_NAME_SKILL && title) {
      const s = this.ledger.skills[title] ?? (this.ledger.skills[title] = { calls: 0, lastAt: 0 })
      s.calls += 1
      s.lastAt = Date.now()
    }
    this.scheduleFlush()
  }

  // ============ 落盘 ============

  private get statsDir(): string {
    return path.join(getSemaRootDir(), STATS_DIR_PATH)
  }

  private productDir(product: string): string {
    return path.join(this.statsDir, product)
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushAsync().catch(e => logError(`使用统计落盘失败: ${e}`))
    }, USAGE_STATS_FLUSH_INTERVAL)
    if (this.flushTimer.unref) this.flushTimer.unref()
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
  }

  /** 取出并清空账本，返回待写的一行；账本为空返回 null */
  private takeLine(): { dir: string; file: string; line: string } | null {
    this.clearTimer()
    if (this.ledger.requests === 0 && Object.keys(this.ledger.tools).length === 0) return null
    const line: UsageLine = { t: Date.now(), ...ledgerToDay(this.ledger) }
    this.ledger = emptyLedger()
    const dir = this.productDir(this.product)
    return { dir, file: path.join(dir, `${getDayTimeString()}.jsonl`), line: JSON.stringify(line) + '\n' }
  }

  private async flushAsync(): Promise<void> {
    const pending = this.takeLine()
    if (!pending) return
    try {
      await fs.promises.mkdir(pending.dir, { recursive: true })
      await fs.promises.appendFile(pending.file, pending.line, 'utf8')
    } catch (e) {
      logError(`使用统计落盘失败: ${e}`)
    }
  }

  private flushSync(): void {
    const pending = this.takeLine()
    if (!pending) return
    try {
      fs.mkdirSync(pending.dir, { recursive: true })
      fs.appendFileSync(pending.file, pending.line, 'utf8')
    } catch (e) {
      logError(`使用统计落盘失败: ${e}`)
    }
  }

  // ============ 列举 / 读取文件 ============

  /** stats/ 下的产品子目录（只取名字合法的目录），目录不存在返回空 */
  private async listProducts(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.statsDir, { withFileTypes: true })
      return entries.filter(e => e.isDirectory() && isValidProduct(e.name)).map(e => e.name).sort()
    } catch (e) {
      if (isENOENT(e)) return []
      throw e
    }
  }

  /** 某产品目录下的日文件，按日期升序；目录不存在返回空 */
  private async listDayFiles(product: string): Promise<Array<{ day: string; file: string }>> {
    const dir = this.productDir(product)
    let names: string[]
    try {
      names = await fs.promises.readdir(dir)
    } catch (e) {
      if (isENOENT(e)) return []
      throw e
    }
    return names
      .map(n => ({ day: DAY_FILE_RE.exec(n)?.[1] ?? '', file: path.join(dir, n) }))
      .filter(f => f.day)
      .sort((a, b) => a.day.localeCompare(b.day))
  }

  private async readLines(file: string): Promise<UsageLine[]> {
    try {
      return parseLines(await fs.promises.readFile(file, 'utf8'))
    } catch (e) {
      if (!isENOENT(e)) logError(`使用统计读取失败 ${path.basename(file)}: ${e}`)
      return []
    }
  }

  /** 先写临时文件再 rename 覆盖，失败时清理临时文件并抛出 */
  private async writeFileAtomic(file: string, content: string): Promise<void> {
    const tmp = `${file}.${process.pid}.tmp`
    try {
      await fs.promises.writeFile(tmp, content, 'utf8')
      await fs.promises.rename(tmp, file)
    } catch (e) {
      await fs.promises.unlink(tmp).catch(() => {})
      throw e
    }
  }

  // ============ 压缩 ============

  /** 把每个产品目录下早于今天且多于一行的文件合并成一行；多进程同时压缩产出相同内容，无需加锁 */
  private async compactOldFiles(): Promise<void> {
    const today = getDayTimeString()
    for (const product of await this.listProducts()) {
      for (const { day, file } of await this.listDayFiles(product)) {
        if (day >= today) continue
        const lines = await this.readLines(file)
        if (lines.length <= 1) continue
        const ledger = emptyLedger()
        let maxT = 0
        for (const l of lines) {
          mergeInto(ledger, l)
          maxT = Math.max(maxT, l.t || 0)
        }
        const merged = JSON.stringify({ t: maxT, ...ledgerToDay(ledger) } as UsageLine) + '\n'
        try {
          await this.writeFileAtomic(file, merged)
        } catch (e) {
          logError(`使用统计压缩失败 ${product}/${path.basename(file)}: ${e}`)
        }
      }
    }
  }

  // ============ 读取 / 清空 ============

  async getUsageStats(opts?: { product?: string }): Promise<UsageStatsData> {
    // 先把内存增量落盘，避免漏掉最近 10 秒的数据
    if (this.product) await this.flushAsync()

    const filter = opts?.product
    const totals = { requests: 0, tokens: emptyTokens(), sessions: 0, days: 0 }
    const days: Record<string, UsageDayData> = {}
    if (filter !== undefined && !isValidProduct(filter)) {
      return { since: null, updatedAt: Date.now(), totals, days }
    }

    // 先按天聚合：同一天可能分布在多个产品目录
    const byDay = new Map<string, Ledger>()
    for (const product of filter ? [filter] : await this.listProducts()) {
      for (const { day, file } of await this.listDayFiles(product)) {
        const lines = await this.readLines(file)
        if (lines.length === 0) continue
        const ledger = byDay.get(day) ?? emptyLedger()
        for (const l of lines) mergeInto(ledger, l)
        byDay.set(day, ledger)
      }
    }

    const today = new Date()
    const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - DAYS_WINDOW)
    const cutoffDay = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}`
    const allSessions = new Set<string>()
    let since: string | null = null

    for (const day of [...byDay.keys()].sort()) {
      const ledger = byDay.get(day)!
      if (since === null) since = day
      totals.days += 1
      totals.requests += ledger.requests
      addTokens(totals.tokens, ledger.tokens)
      ledger.sessions.forEach(id => allSessions.add(id))
      if (day > cutoffDay) days[day] = ledgerToDay(ledger)
    }
    totals.sessions = allSessions.size
    return { since, updatedAt: Date.now(), totals, days }
  }

  /** 删除该产品的统计目录；产品为本进程产品时同时清内存账本 */
  async clearUsageStats(product: string): Promise<void> {
    if (!isValidProduct(product)) {
      logError(`使用统计清空失败：product "${product}" 不是合法目录名`)
      return
    }
    if (product === this.product) {
      this.clearTimer()
      this.ledger = emptyLedger()
    }
    try {
      await fs.promises.rm(this.productDir(product), { recursive: true, force: true })
    } catch (e) {
      logError(`使用统计清空失败 ${product}: ${e}`)
    }
  }
}

// 单例
let instance: UsageStatsManager | null = null

export function getUsageStatsManager(): UsageStatsManager {
  if (!instance) {
    instance = new UsageStatsManager()
  }
  return instance
}

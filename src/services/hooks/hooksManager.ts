/**
 * Hooks 管理器
 *
 * 负责 hooks.json 的加载、合并、校验、缓存与 matcher 匹配。
 * 加载顺序：用户级(~/.sema/hooks/hooks.json) → 项目级(<workingDir>/.sema/hooks/hooks.json)，
 * 同一事件的条目按加载顺序追加（不覆盖）。
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { findJsonKeyValueLineRange } from '../../util/file'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getSemaRootDir } from '../../util/savePath'
import { readInitialCwd } from '../../util/cwd'
import {
  HOOK_EVENTS,
  TOOL_HOOK_EVENTS,
  HookEntryInfo,
  HooksInfo,
  LoadedHookEntry,
  RawHooksFile,
} from '../../types/hook'

// 配置文件位于 hooks 子目录下（hook 脚本可与配置同目录存放）
const HOOKS_DIR_NAME = 'hooks'
const HOOKS_FILE_NAME = 'hooks.json'
const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 60
const MAX_TIMEOUT_PERMISSION_REQUEST_S = 120

const HOOK_EVENT_SET: ReadonlySet<string> = new Set(HOOK_EVENTS)

type MatcherPredicate = (claudeName?: string, semaName?: string) => boolean

class HooksManager {
  private userConfigPath: string
  private projectConfigPath: string

  private entriesByEvent: Map<string, LoadedHookEntry[]> | null = null
  private infoCache: HooksInfo | null = null
  private loadingPromise: Promise<void> | null = null
  private matcherCache = new Map<string, MatcherPredicate>()

  constructor() {
    this.userConfigPath = path.join(getSemaRootDir(), HOOKS_DIR_NAME, HOOKS_FILE_NAME)
    this.projectConfigPath = path.join(readInitialCwd(), '.sema', HOOKS_DIR_NAME, HOOKS_FILE_NAME)

    // 后台静默加载 hooks 配置
    this.startLoad()
  }

  /**
   * 发起一次加载（single-flight：并发调用共享同一个在飞 promise，避免重复文件 IO）
   */
  private startLoad(): Promise<void> {
    if (!this.loadingPromise) {
      this.loadingPromise = this.loadAndCache().finally(() => {
        this.loadingPromise = null
      })
    }
    return this.loadingPromise
  }

  /**
   * 等待配置缓存就绪（就绪后近零开销）
   */
  async ready(): Promise<void> {
    if (this.entriesByEvent) return
    await this.startLoad()
  }

  /**
   * 配置缓存是否已就绪（同步判断，供需要同步捕获条目的调用方使用）
   */
  isReady(): boolean {
    return this.entriesByEvent !== null
  }

  /**
   * 返回指定事件下 matcher 命中的可执行条目（仅 status === 'ok'）
   * 工具类事件按 Claude 风格名 / 内置名匹配；其他事件忽略 matcher 总是触发
   */
  getMatchedEntries(event: string, claudeToolName?: string, semaToolName?: string): LoadedHookEntry[] {
    const entries = this.entriesByEvent?.get(event)
    if (!entries || entries.length === 0) return []

    const isToolEvent = TOOL_HOOK_EVENTS.has(event)
    return entries.filter(entry => {
      if (entry.status !== 'ok') return false
      if (!isToolEvent) return true
      return this.compileMatcher(entry.matcher)(claudeToolName, semaToolName)
    })
  }

  /**
   * 获取合并后的配置视图
   * @param refresh true 时重新加载配置，下一次 hook 触发即生效
   */
  async getHooksInfo(refresh?: boolean): Promise<HooksInfo> {
    if (refresh || !this.infoCache) {
      if (!refresh && this.loadingPromise) {
        await this.loadingPromise
      }
      if (refresh || !this.infoCache) {
        await this.loadAndCache()
      }
    }
    return { ...this.infoCache! }
  }

  private invalidateCache(): void {
    this.entriesByEvent = null
    this.infoCache = null
    this.matcherCache.clear()
  }

  /**
   * 加载并缓存配置。保证不抛错且总是落缓存：任何异常兜底为空配置，
   * 避免缓存留 null 导致后续每次 hook 触发都重试文件 IO
   */
  private async loadAndCache(): Promise<void> {
    logDebug('刷新 Hooks 配置...')
    const parseErrors: Array<{ source: 'user' | 'project'; message: string }> = []
    const allEntries: LoadedHookEntry[] = []
    const rawBySource: Partial<Record<'user' | 'project', string>> = {}
    let userExists = false
    let projectExists = false

    try {
      userExists = fs.existsSync(this.userConfigPath)
      projectExists = fs.existsSync(this.projectConfigPath)

      // 用户级 → 项目级，条目追加不覆盖
      for (const [source, filePath, exists] of [
        ['user', this.userConfigPath, userExists],
        ['project', this.projectConfigPath, projectExists],
      ] as Array<['user' | 'project', string, boolean]>) {
        if (!exists) continue
        try {
          const raw = await fsPromises.readFile(filePath, 'utf-8')
          const parsed = JSON.parse(raw) as RawHooksFile
          rawBySource[source] = raw
          allEntries.push(...this.parseHooksFile(parsed, source))
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logWarn(`Hooks 配置解析失败 [${filePath}]: ${message}`)
          parseErrors.push({ source, message })
        }
      }
    } catch (error) {
      logError(`加载 Hooks 配置失败(按空配置处理): ${error}`)
      allEntries.length = 0
    }

    // 事件块行范围定位（供 IDE 跳转），按 source+event 缓存，定位失败退化为纯配置文件路径
    const locationCache = new Map<string, string>()
    const locateEvent = (source: 'user' | 'project', event: string): string => {
      const cacheKey = `${source}:${event}`
      const cached = locationCache.get(cacheKey)
      if (cached) return cached
      const filePath = source === 'user' ? this.userConfigPath : this.projectConfigPath
      const raw = rawBySource[source]
      const range = raw ? findJsonKeyValueLineRange(raw, `"${event}"`) : undefined
      const location = range ? `${filePath}:${range[0]}-${range[1]}` : filePath
      locationCache.set(cacheKey, location)
      return location
    }

    const entriesByEvent = new Map<string, LoadedHookEntry[]>()
    const eventsView: Record<string, HookEntryInfo[]> = {}
    for (const entry of allEntries) {
      if (!entriesByEvent.has(entry.event)) {
        entriesByEvent.set(entry.event, [])
        eventsView[entry.event] = []
      }
      entriesByEvent.get(entry.event)!.push(entry)
      eventsView[entry.event].push({
        event: entry.event,
        source: entry.source,
        matcher: entry.matcher,
        command: entry.command,
        timeout: entry.timeoutRaw,
        status: entry.status,
        statusReason: entry.statusReason,
        filePath: locateEvent(entry.source, entry.event),
      })
    }

    this.entriesByEvent = entriesByEvent
    this.matcherCache.clear()
    this.infoCache = {
      userConfigPath: this.userConfigPath,
      projectConfigPath: this.projectConfigPath,
      userConfigExists: userExists,
      projectConfigExists: projectExists,
      parseErrors,
      events: eventsView,
    }

    const okCount = allEntries.filter(e => e.status === 'ok').length
    if (allEntries.length > 0 || parseErrors.length > 0) {
      logInfo(`Hooks 配置刷新完成: ${okCount}/${allEntries.length} 条可用`)
    }
  }

  /**
   * 解析单个 hooks.json 内容为条目列表（校验只标 status，不抛错）
   */
  private parseHooksFile(parsed: RawHooksFile, source: 'user' | 'project'): LoadedHookEntry[] {
    const entries: LoadedHookEntry[] = []
    const hooks = parsed?.hooks
    if (!hooks || typeof hooks !== 'object') return entries

    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) continue
        const matcher = typeof group.matcher === 'string' ? group.matcher : undefined

        for (const cmd of group.hooks) {
          if (!cmd || typeof cmd !== 'object') continue
          const command = typeof cmd.command === 'string' ? cmd.command.trim() : ''
          const timeoutRaw = typeof cmd.timeout === 'number' && Number.isFinite(cmd.timeout)
            ? cmd.timeout
            : undefined

          const entry: LoadedHookEntry = {
            event,
            source,
            matcher,
            command,
            timeoutMs: this.clampTimeoutMs(event, timeoutRaw),
            timeoutRaw,
            failClosed: cmd.failClosed === true,
            status: 'ok',
          }

          // 校验（顺序即优先级，命中即定案）
          if (cmd.type !== undefined && cmd.type !== 'command') {
            entry.status = 'skipped'
            entry.statusReason = `unsupported type: ${cmd.type}`
            logWarn(`[Hook] 跳过不支持的 hook 类型 [${source}] ${event}: ${cmd.type}`)
          } else if ('if' in cmd) {
            // 忽略 if 会把条件触发放大成无条件触发，比不执行更糟，整条跳过
            entry.status = 'skipped'
            entry.statusReason = `contains 'if' condition`
            logWarn(`[Hook] 跳过含 'if' 条件的 hook 条目 [${source}] ${event}`)
          } else if (!command) {
            entry.status = 'invalid'
            entry.statusReason = 'missing command'
          } else if (!HOOK_EVENT_SET.has(event)) {
            entry.status = 'invalid'
            entry.statusReason = 'unknown event'
            logWarn(`[Hook] 未支持的 hook 事件 [${source}]: ${event}`)
          } else if (matcher !== undefined && !TOOL_HOOK_EVENTS.has(event)) {
            entry.statusReason = 'matcher ignored for non-tool event'
            logWarn(`[Hook] ${event} 不支持 matcher，将总是触发 [${source}]`)
          }

          entries.push(entry)
        }
      }
    }
    return entries
  }

  private clampTimeoutMs(event: string, timeoutS?: number): number {
    const max = event === 'PermissionRequest' ? MAX_TIMEOUT_PERMISSION_REQUEST_S : MAX_TIMEOUT_S
    if (timeoutS === undefined) return DEFAULT_TIMEOUT_S * 1000
    const clamped = Math.min(Math.max(Math.floor(timeoutS), 1), max)
    if (clamped !== timeoutS) {
      logWarn(`[Hook] timeout ${timeoutS}s 超出范围 [1, ${max}]，已调整为 ${clamped}s`)
    }
    return clamped * 1000
  }

  /**
   * matcher 编译（结果按 matcher 字符串缓存）：
   * 1. 缺失/空串/'*' → 全匹配
   * 2. 按 '|' 分段后每段均为简单名 → 精确集合匹配（Claude 名和内置名均可命中）
   * 3. 否则整串按正则匹配 Claude 风格名；编译失败 logWarn 一次且该条永不匹配
   */
  private compileMatcher(matcher?: string): MatcherPredicate {
    const key = matcher ?? ''
    const cached = this.matcherCache.get(key)
    if (cached) return cached

    let predicate: MatcherPredicate
    const trimmed = key.trim()
    if (!trimmed || trimmed === '*') {
      predicate = () => true
    } else {
      const parts = trimmed.split('|')
      const isSimple = parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))
      if (isSimple) {
        const nameSet = new Set(parts)
        predicate = (claudeName, semaName) =>
          (claudeName !== undefined && nameSet.has(claudeName)) ||
          (semaName !== undefined && nameSet.has(semaName))
      } else {
        try {
          const regex = new RegExp(trimmed)
          predicate = claudeName => claudeName !== undefined && regex.test(claudeName)
        } catch (error) {
          logWarn(`[Hook] matcher 正则编译失败，该条目永不匹配: ${trimmed} (${error})`)
          predicate = () => false
        }
      }
    }
    this.matcherCache.set(key, predicate)
    return predicate
  }

  dispose(): void {
    this.invalidateCache()
  }
}

// ===================== 全局 Hooks 管理器 =====================

let hooksManagerInstance: HooksManager | null = null

/**
 * 获取 Hooks Manager 实例（单例模式）
 */
export function getHooksManager(): HooksManager {
  if (!hooksManagerInstance) {
    hooksManagerInstance = new HooksManager()
  }
  return hooksManagerInstance
}

export { HooksManager }

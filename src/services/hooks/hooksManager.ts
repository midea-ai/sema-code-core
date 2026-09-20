/**
 * Hooks 管理器
 *
 * 负责 hooks.json 的加载、合并、校验、缓存与 matcher 匹配。
 * 加载顺序：已启用插件(<插件目录>/hooks/hooks.json) → 用户级(~/.sema/hooks/hooks.json)
 * → 项目级(<workingDir>/.sema/hooks/hooks.json)，同一事件的条目按加载顺序追加（不覆盖）。
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { findJsonKeyValueLineRange } from '../../util/file'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getSemaRootDir } from '../../util/savePath'
import { readInitialCwd } from '../../util/cwd'
import { getPluginsManager } from '../plugins/pluginsManager'
import { expandPluginRoot } from '../../prompt/toolAliases'
import {
  HOOK_EVENTS,
  TOOL_HOOK_EVENTS,
  HookEntryInfo,
  HookSource,
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

type MatcherPredicate = (genericName?: string, semaName?: string) => boolean

// 一个待加载的 hooks 配置文件及其来源
interface HookFileSource {
  source: HookSource
  filePath: string
  pluginName?: string // 仅插件来源
  pluginRoot?: string // 仅插件来源：插件安装目录，用于展开命令中的插件根目录变量
}

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
   * 工具类事件按通用工具名 / 内置名匹配；其他事件忽略 matcher 总是触发
   */
  getMatchedEntries(event: string, genericToolName?: string, semaToolName?: string): LoadedHookEntry[] {
    const entries = this.entriesByEvent?.get(event)
    if (!entries || entries.length === 0) return []

    const isToolEvent = TOOL_HOOK_EVENTS.has(event)
    return entries.filter(entry => {
      if (entry.status !== 'ok') return false
      if (!isToolEvent) return true
      return this.compileMatcher(entry.matcher)(genericToolName, semaToolName)
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
    const parseErrors: HooksInfo['parseErrors'] = []
    const allEntries: LoadedHookEntry[] = []
    const rawByFile = new Map<string, string>()
    let userExists = false
    let projectExists = false

    try {
      userExists = fs.existsSync(this.userConfigPath)
      projectExists = fs.existsSync(this.projectConfigPath)

      // 插件 → 用户级 → 项目级，条目追加不覆盖（顺序即同一事件下的执行先后）
      const files: HookFileSource[] = [...await this.listPluginHookFiles()]
      if (userExists) files.push({ source: 'user', filePath: this.userConfigPath })
      if (projectExists) files.push({ source: 'project', filePath: this.projectConfigPath })

      for (const file of files) {
        try {
          const raw = await fsPromises.readFile(file.filePath, 'utf-8')
          const parsed = JSON.parse(raw) as RawHooksFile
          rawByFile.set(file.filePath, raw)
          allEntries.push(...this.parseHooksFile(parsed, file))
        } catch (error) {
          // 单个文件解析失败只记 parseErrors，不影响其他来源
          const message = error instanceof Error ? error.message : String(error)
          logWarn(`Hooks 配置解析失败 [${file.filePath}]: ${message}`)
          parseErrors.push({
            source: file.source,
            ...(file.pluginName ? { pluginName: file.pluginName } : {}),
            message,
          })
        }
      }
    } catch (error) {
      logError(`加载 Hooks 配置失败(按空配置处理): ${error}`)
      allEntries.length = 0
    }

    // 事件块行范围定位（供 IDE 跳转），按 配置文件+event 缓存，定位失败退化为纯配置文件路径
    const locationCache = new Map<string, string>()
    const locateEvent = (configPath: string, event: string): string => {
      const cacheKey = `${configPath}:${event}`
      const cached = locationCache.get(cacheKey)
      if (cached) return cached
      const raw = rawByFile.get(configPath)
      const range = raw ? findJsonKeyValueLineRange(raw, `"${event}"`) : undefined
      const location = range ? `${configPath}:${range[0]}-${range[1]}` : configPath
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
        ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
        matcher: entry.matcher,
        command: entry.command,
        timeout: entry.timeoutRaw,
        status: entry.status,
        statusReason: entry.statusReason,
        filePath: locateEvent(entry.configPath, entry.event),
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
   * 列出已启用插件自带的 hooks 配置文件（<插件目录>/hooks/hooks.json）。
   * 只取已启用插件：禁用/卸载插件后其 hooks 随下一次刷新消失（pluginsManager 刷新后会级联触发本管理器刷新）。
   * 插件信息获取失败时按无插件 hooks 处理，不影响用户级/项目级。
   */
  private async listPluginHookFiles(): Promise<HookFileSource[]> {
    try {
      const pluginsInfo = await getPluginsManager().getMarketplacePluginsInfo()
      const files: HookFileSource[] = []
      for (const plugin of pluginsInfo.plugins) {
        if (!plugin.status) continue
        for (const entry of plugin.components.hooks ?? []) {
          files.push({
            source: 'plugin',
            filePath: entry.filePath,
            pluginName: plugin.name,
            // hooks.json 位于 <插件目录>/hooks/ 下，插件根目录为其上上级
            pluginRoot: path.dirname(path.dirname(entry.filePath)),
          })
        }
      }
      return files
    } catch (error) {
      logError(`加载插件 Hooks 失败: ${error}`)
      return []
    }
  }

  /**
   * 解析单个 hooks.json 内容为条目列表（校验只标 status，不抛错）
   */
  private parseHooksFile(parsed: RawHooksFile, file: HookFileSource): LoadedHookEntry[] {
    const { source } = file
    const label = file.pluginName ? `plugin:${file.pluginName}` : source // 日志用来源标签
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
          const rawCommand = typeof cmd.command === 'string' ? cmd.command.trim() : ''
          // 插件条目展开插件根目录变量，使命令能定位插件自带脚本；用户级/项目级不展开（其余 ${VAR} 均留给 shell）
          const command = file.pluginRoot ? expandPluginRoot(rawCommand, file.pluginRoot) : rawCommand
          const timeoutRaw = typeof cmd.timeout === 'number' && Number.isFinite(cmd.timeout)
            ? cmd.timeout
            : undefined

          const entry: LoadedHookEntry = {
            event,
            source,
            ...(file.pluginName ? { pluginName: file.pluginName } : {}),
            configPath: file.filePath,
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
            logWarn(`[Hook] 跳过不支持的 hook 类型 [${label}] ${event}: ${cmd.type}`)
          } else if ('if' in cmd) {
            // 忽略 if 会把条件触发放大成无条件触发，比不执行更糟，整条跳过
            entry.status = 'skipped'
            entry.statusReason = `contains 'if' condition`
            logWarn(`[Hook] 跳过含 'if' 条件的 hook 条目 [${label}] ${event}`)
          } else if (!command) {
            entry.status = 'invalid'
            entry.statusReason = 'missing command'
          } else if (!HOOK_EVENT_SET.has(event)) {
            entry.status = 'invalid'
            entry.statusReason = 'unknown event'
            logWarn(`[Hook] 未支持的 hook 事件 [${label}]: ${event}`)
          } else if (matcher !== undefined && !TOOL_HOOK_EVENTS.has(event)) {
            entry.statusReason = 'matcher ignored for non-tool event'
            logWarn(`[Hook] ${event} 不支持 matcher，将总是触发 [${label}]`)
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
   * 2. 按 '|' 分段后每段均为简单名 → 精确集合匹配（通用工具名和内置名均可命中）
   * 3. 否则整串按正则匹配通用工具名；编译失败 logWarn 一次且该条永不匹配
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
        predicate = (genericName, semaName) =>
          (genericName !== undefined && nameSet.has(genericName)) ||
          (semaName !== undefined && nameSet.has(semaName))
      } else {
        try {
          const regex = new RegExp(trimmed)
          predicate = genericName => genericName !== undefined && regex.test(genericName)
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

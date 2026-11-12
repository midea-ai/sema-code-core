/**
 * Hooks 管理器
 *
 * 负责 hooks.json 的加载、合并、校验、缓存与 matcher 匹配。
 * 加载顺序：宿主传入(host 域) → 已启用插件(<插件目录>/hooks/hooks.json) → 用户级(~/.sema/hooks/hooks.json)
 * → 项目级(<workingDir>/.sema/hooks/hooks.json)，同一事件的条目按加载顺序追加（不覆盖）。
 * 用户级 / 项目级只在对应域生效时加载（scopes.hooks，见 conf/hostConfig.ts）。
 *
 * 增删与启停：
 * - 增删只写用户级 / 项目级 hooks.json；插件条目只能启停，host 条目只读
 * - 启停：settings.json -> disabledHooks 存条目 id（用户级 ~/.sema + 项目级 .sema 取并集生效；host 条目不受影响）
 * - disabledHooks 里的残留 id 不在加载时清理：用户级 settings 跨项目共享，条目暂时不在（插件被禁用、换了项目）不代表可以丢掉启停状态
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { findJsonKeyValueLineRange } from '../../util/file'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getSemaRootDir } from '../../util/savePath'
import { readInitialCwd } from '../../util/cwd'
import { getPluginsManager } from '../plugins/pluginsManager'
import { expandPluginRoot } from '../../prompt/toolAliases'
import { assertScopeEnabled, getHostConfig, isScopeEnabled } from '../../conf/hostConfig'
import { readSettings, writeSettings } from '../settings/settingsLoader'
import { SettingsScope } from '../../types/settings'
import { SemaError, hostReadonlyError } from '../../util/errors'
import {
  HOOK_EVENTS,
  TOOL_HOOK_EVENTS,
  HookConfig,
  HookEntryInfo,
  HookSource,
  HooksInfo,
  LoadedHookEntry,
  RawHookCommand,
  RawHookMatcherGroup,
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
  filePath: string // host 来源为 ''（内容在 raw 里，不读文件）
  raw?: RawHooksFile // 仅 host 来源：宿主传入的内容
  pluginName?: string // 仅插件来源
  pluginRoot?: string // 仅插件来源：插件安装目录，用于展开命令中的插件根目录变量
}

/**
 * 条目标识：来源 + 插件名 + 事件 + matcher + 配置里的原始命令 的 sha1 前 12 位。
 * 用原始命令而非展开后的：插件升级换安装目录后 id 不变。没有命令的条目（不支持的类型等）拿整条配置参与，避免彼此撞 id
 */
function hookEntryId(source: HookSource, pluginName: string | undefined, event: string, matcher: unknown, cmd: RawHookCommand): string {
  const rawCommand = typeof cmd.command === 'string' ? cmd.command.trim() : ''
  const basis = rawCommand || JSON.stringify(cmd)
  const key = JSON.stringify([source, pluginName ?? '', event, typeof matcher === 'string' ? matcher : '', basis])
  return createHash('sha1').update(key).digest('hex').slice(0, 12)
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
   * 返回指定事件下 matcher 命中的可执行条目（仅 status === 'ok' 且已启用）
   * 工具类事件按通用工具名 / 内置名匹配；其他事件忽略 matcher 总是触发
   */
  getMatchedEntries(event: string, genericToolName?: string, semaToolName?: string): LoadedHookEntry[] {
    const entries = this.entriesByEvent?.get(event)
    if (!entries || entries.length === 0) return []

    const isToolEvent = TOOL_HOOK_EVENTS.has(event)
    return entries.filter(entry => {
      if (entry.status !== 'ok' || !entry.enabled) return false
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

  // ==================== 增删与启停 ====================

  /**
   * 新增 hook：写入 scope 对应层的 hooks.json（同事件下 matcher 相同的组追加，否则新建一组）。
   * 内容完全相同的条目已存在时不重复写
   */
  async addHook(conf: HookConfig): Promise<HooksInfo> {
    // 写入层只有 user / project 两种，缺省为用户级；明确传了其他值（host / plugin、拼错）报错，不悄悄落到用户级
    const scope = conf?.scope ?? 'user'
    if (scope !== 'user' && scope !== 'project') {
      throw new SemaError('CONFIG_INVALID', `Hook scope must be 'user' or 'project', got '${String(scope)}'`)
    }
    // 域没生效报 SCOPE_DISABLED
    assertScopeEnabled('hooks', scope)

    const event = conf?.event
    if (typeof event !== 'string' || !HOOK_EVENT_SET.has(event)) {
      throw new SemaError('CONFIG_INVALID', `Unknown hook event '${String(event)}' (allowed: ${HOOK_EVENTS.join(', ')})`)
    }
    const command = typeof conf.command === 'string' ? conf.command.trim() : ''
    if (!command) throw new SemaError('CONFIG_INVALID', 'Hook command must be a non-empty string')
    if (conf.matcher !== undefined && typeof conf.matcher !== 'string') {
      throw new SemaError('CONFIG_INVALID', 'Hook matcher must be a string')
    }
    if (conf.timeout !== undefined && !(typeof conf.timeout === 'number' && Number.isFinite(conf.timeout) && conf.timeout > 0)) {
      throw new SemaError('CONFIG_INVALID', 'Hook timeout must be a positive number of seconds')
    }
    const matcher = conf.matcher?.trim() || undefined

    const cmd: RawHookCommand = {
      type: 'command',
      command,
      ...(conf.timeout !== undefined ? { timeout: conf.timeout } : {}),
      ...(conf.failClosed === true ? { failClosed: true } : {}),
    }
    const configPath = scope === 'project' ? this.projectConfigPath : this.userConfigPath
    const file = this.readHooksFileForWrite(configPath)
    if (!file.hooks) file.hooks = {}
    const groups = file.hooks[event] ?? (file.hooks[event] = [])
    if (!Array.isArray(groups)) throw new Error(`Invalid hooks config [${configPath}]: hooks.${event} must be an array`)

    const id = hookEntryId(scope, undefined, event, matcher, cmd)
    const isGroup = (g: unknown): g is RawHookMatcherGroup & { hooks: RawHookCommand[] } =>
      !!g && typeof g === 'object' && Array.isArray((g as RawHookMatcherGroup).hooks)
    const exists = groups.some(g => isGroup(g) && g.hooks.some(c => !!c && typeof c === 'object' && hookEntryId(scope, undefined, event, g.matcher, c) === id))
    if (exists) {
      logInfo(`Hook 已存在，未重复添加 [${scope}] ${event}: ${command}`)
      return this.getHooksInfo(true)
    }

    const sameMatcher = groups.find(g => isGroup(g) && (typeof g.matcher === 'string' ? g.matcher : '') === (matcher ?? ''))
    if (sameMatcher) {
      sameMatcher.hooks!.push(cmd)
    } else {
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [cmd] })
    }
    this.writeHooksFile(configPath, file)
    logInfo(`添加 Hook 到 ${scope} 级配置 ${event}: ${command}`)
    return this.getHooksInfo(true)
  }

  /**
   * 移除 hook：只能移除用户级 / 项目级条目（从所属 hooks.json 删掉，组和事件删空后一并去掉）。
   * host 条目报 HOST_READONLY；插件条目随插件更新被覆盖，只能禁用
   */
  async removeHook(id: string): Promise<HooksInfo> {
    await this.ready()
    const entry = this.findEntry(id)
    if (!entry) {
      logWarn(`移除 Hook 失败: 未找到 [${id}]`)
      return this.getHooksInfo()
    }
    if (entry.source === 'host') throw hostReadonlyError('Hook', id)
    if (entry.source === 'plugin') {
      throw new Error(`Hook '${id}' belongs to plugin '${entry.pluginName}' and cannot be removed; disable it instead`)
    }

    const { source, event, configPath } = entry
    const file = this.readHooksFileForWrite(configPath)
    const groups = file.hooks?.[event]
    if (Array.isArray(groups)) {
      const kept = groups.filter(group => {
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return true
        const before = group.hooks.length
        group.hooks = group.hooks.filter(c => !(c && typeof c === 'object' && hookEntryId(source, undefined, event, group.matcher, c) === id))
        // 只去掉本次删空的组，原本就空的组不动
        return group.hooks.length > 0 || group.hooks.length === before
      })
      if (kept.length > 0) file.hooks![event] = kept
      else delete file.hooks![event]
      this.writeHooksFile(configPath, file)
    }

    // 清理同层 settings 中的禁用记录（写入层与启停对称，见 toggleScope）
    const settingsScope = this.toggleScope(entry)
    const settings = readSettings(settingsScope)
    if (settings.disabledHooks?.includes(id)) {
      settings.disabledHooks = settings.disabledHooks.filter(n => n !== id)
      writeSettings(settingsScope, settings)
    }
    logInfo(`移除 Hook [${id}] ${event}: ${entry.command}`)
    return this.getHooksInfo(true)
  }

  /**
   * 启用/禁用 hook：写入 settings 的 disabledHooks（写入层见 toggleScope）。
   * 启用只从目标层移除；若另一层仍禁用，最终仍为禁用
   */
  async setHookEnabled(id: string, enabled: boolean): Promise<HooksInfo> {
    await this.ready()
    const entry = this.findEntry(id)
    if (!entry) {
      logWarn(`${enabled ? '启用' : '禁用'} Hook 失败: 未找到 [${id}]`)
      return this.getHooksInfo()
    }
    if (entry.source === 'host') throw hostReadonlyError('Hook', id)

    const scope = this.toggleScope(entry)
    const settings = readSettings(scope)
    const list = settings.disabledHooks ?? []
    settings.disabledHooks = enabled ? list.filter(n => n !== id) : (list.includes(id) ? list : [...list, id])
    writeSettings(scope, settings)
    if (enabled && this.readDisabledHooks().has(id)) {
      logWarn(`Hook [${id}] 在另一层 settings 中仍被禁用`)
    }
    logInfo(`${enabled ? '启用' : '禁用'} Hook [${id}]（${scope} 级）${entry.event}: ${entry.command}`)
    return this.getHooksInfo(true)
  }

  /**
   * 启停写入哪层 settings：跟随条目所在层（项目级写项目级，用户级 / 插件写用户级，即全局生效）
   */
  private toggleScope(entry: LoadedHookEntry): SettingsScope {
    return entry.source === 'project' ? 'project' : 'user'
  }

  /**
   * 读取禁用的 hook id 集合（用户级 + 项目级并集）。
   * 手改 settings 写成非数组时按空列表处理：这里在 loadAndCache 的 try 之外，抛错会让缓存一直落不下来
   */
  private readDisabledHooks(): Set<string> {
    const list = (value: unknown): string[] => (Array.isArray(value) ? value : [])
    return new Set([...list(readSettings('user').disabledHooks), ...list(readSettings('project').disabledHooks)])
  }

  private findEntry(id: string): LoadedHookEntry | undefined {
    for (const entries of this.entriesByEvent?.values() ?? []) {
      const hit = entries.find(e => e.id === id)
      if (hit) return hit
    }
    return undefined
  }

  /**
   * 读出待改写的 hooks.json（文件不存在视为空配置）。
   * 解析失败或结构不对直接抛错：改写会整体回写，不能拿空配置盖掉用户写坏的文件
   */
  private readHooksFileForWrite(configPath: string): RawHooksFile {
    if (!fs.existsSync(configPath)) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    } catch (error) {
      throw new Error(`Failed to parse hooks config [${configPath}]: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Invalid hooks config [${configPath}]: root must be an object`)
    }
    const hooks = (parsed as RawHooksFile).hooks
    if (hooks !== undefined && (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))) {
      throw new Error(`Invalid hooks config [${configPath}]: hooks must be an object`)
    }
    return parsed as RawHooksFile
  }

  private writeHooksFile(configPath: string, file: RawHooksFile): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(file, null, 2), 'utf-8')
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
    // 域没生效的那层：不读文件，视图里路径为 ''、存在标记为 false
    const userEnabled = isScopeEnabled('hooks', 'user')
    const projectEnabled = isScopeEnabled('hooks', 'project')
    let userExists = false
    let projectExists = false

    try {
      userExists = userEnabled && fs.existsSync(this.userConfigPath)
      projectExists = projectEnabled && fs.existsSync(this.projectConfigPath)

      // host → 插件 → 用户级 → 项目级，条目追加不覆盖（顺序即同一事件下的执行先后）
      const files: HookFileSource[] = []
      const hostHooks = getHostConfig().hooks
      if (hostHooks) files.push({ source: 'host', filePath: '', raw: { hooks: hostHooks } })
      files.push(...await this.listPluginHookFiles())
      if (userExists) files.push({ source: 'user', filePath: this.userConfigPath })
      if (projectExists) files.push({ source: 'project', filePath: this.projectConfigPath })

      for (const file of files) {
        try {
          let parsed: RawHooksFile
          if (file.raw) {
            parsed = file.raw
          } else {
            const raw = await fsPromises.readFile(file.filePath, 'utf-8')
            parsed = JSON.parse(raw) as RawHooksFile
            rawByFile.set(file.filePath, raw)
          }
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

    // 启停状态：host 条目恒为启用，其余按 settings 的 disabledHooks（用户级 + 项目级并集）
    const disabled = this.readDisabledHooks()
    const entriesByEvent = new Map<string, LoadedHookEntry[]>()
    const eventsView: Record<string, HookEntryInfo[]> = {}
    for (const entry of allEntries) {
      entry.enabled = entry.source === 'host' || !disabled.has(entry.id)
      if (!entriesByEvent.has(entry.event)) {
        entriesByEvent.set(entry.event, [])
        eventsView[entry.event] = []
      }
      entriesByEvent.get(entry.event)!.push(entry)
      eventsView[entry.event].push({
        id: entry.id,
        enabled: entry.enabled,
        event: entry.event,
        source: entry.source,
        ...(entry.pluginName ? { pluginName: entry.pluginName } : {}),
        matcher: entry.matcher,
        command: entry.command,
        timeout: entry.timeoutRaw,
        status: entry.status,
        statusReason: entry.statusReason,
        // host 条目没有配置文件，不给定位
        ...(entry.configPath ? { filePath: locateEvent(entry.configPath, entry.event) } : {}),
      })
    }

    this.entriesByEvent = entriesByEvent
    this.matcherCache.clear()
    this.infoCache = {
      userConfigPath: userEnabled ? this.userConfigPath : '',
      projectConfigPath: projectEnabled ? this.projectConfigPath : '',
      userConfigExists: userExists,
      projectConfigExists: projectExists,
      parseErrors,
      events: eventsView,
    }

    const okCount = allEntries.filter(e => e.status === 'ok' && e.enabled).length
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
            id: hookEntryId(source, file.pluginName, event, group.matcher, cmd),
            enabled: true, // 加载完统一按 settings 的 disabledHooks 回填，见 loadAndCache
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

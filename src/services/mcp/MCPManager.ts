/**
 * MCP 管理器
 *
 * 管理 MCP Server 配置，从多个来源加载
 * 实现优先级：插件 < 用户级 < 项目级
 *
 * 状态管理：
 * - 服务启用/禁用：settings.json -> disabledMcpServers（用户级 ~/.sema + 项目级 .sema 取并集生效）
 * - 可用工具列表：settings.json -> enabledMcpServerUseTools（用户级打底、项目级同名覆盖）
 *
 * 变量展开：.mcp.json 条目的 command / args / env / url / headers 支持
 * - ${SEMA_PLUGIN_ROOT}：该 .mcp.json 所属根目录（插件目录；<project>/.sema/.mcp.json 为 <project>）
 * - ${VAR}、${VAR:-默认值}：进程环境变量，未定义且无默认值时原样保留
 */

import * as fs from 'fs'
import * as path from 'path'
import { MCPClient } from './MCPClient'
import { createMCPToolAdapter } from './MCPToolAdapter'
import { Tool } from '../../tools/base/Tool'
import { MCPServerConfig, MCPScopeType, MCPServerInfo } from '../../types/mcp'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { EventBus } from '../../events/EventSystem'
import { getSemaRootDir } from '../../util/savePath'
import { readInitialCwd } from '../../util/cwd'
import { findJsonObjectLineRange } from '../../util/file'
import { existsSync, readFileSync } from 'fs'
import { readSettings, writeSettings } from '../settings/settingsLoader'
import { SemaSettings, SettingsScope } from '../../types/settings'

// ==================== .mcp.json 变量展开 ====================

const MCP_EXPANDABLE_FIELDS = ['command', 'args', 'env', 'url', 'headers'] as const
const MCP_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * .mcp.json 所属根目录：文件所在目录叫 .sema 就取上一级（用户级、项目级），否则取本级（插件目录）
 */
function mcpConfigRoot(filePath: string): string {
  const dir = path.dirname(filePath)
  return path.basename(dir) === '.sema' ? path.dirname(dir) : dir
}

function expandMcpValue(value: unknown, root: string): unknown {
  if (typeof value === 'string') {
    return value.replace(MCP_VAR_PATTERN, (whole, name: string, fallback: string | undefined) => {
      if (name === 'SEMA_PLUGIN_ROOT') return root
      const env = process.env[name]
      if (env !== undefined) return env
      return fallback !== undefined ? fallback : whole
    })
  }
  if (Array.isArray(value)) return value.map(v => expandMcpValue(v, root))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandMcpValue(v, root)]))
  }
  return value
}

/**
 * 对每个服务条目的 command / args / env / url / headers 做变量展开，返回新对象，不改原始数据
 */
function expandMcpServers(servers: Record<string, any>, filePath: string): Record<string, any> {
  const root = mcpConfigRoot(filePath)
  const out: Record<string, any> = {}
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') {
      out[name] = raw
      continue
    }
    const entry: Record<string, any> = { ...raw }
    for (const field of MCP_EXPANDABLE_FIELDS) {
      if (field in entry) entry[field] = expandMcpValue(entry[field], root)
    }
    out[name] = entry
  }
  return out
}

/**
 * MCP 管理器类 - 单例模式
 */
class MCPManager {
  private semaUserConfigPath: string      // ~/.sema/.mcp.json
  private semaProjectConfigPath: string   // <project>/.sema/.mcp.json

  // Server 信息缓存
  private serverInfoCache: MCPServerInfo[] | null = null
  // 刷新排队链：所有刷新串行执行，并发进来的刷新看到的是上一次的完整结果，
  // 避免两次刷新交错时把同一个服务当成"新增"连两遍（新会话级联刷新与构造首刷在启动时会重叠）
  private refreshChain: Promise<MCPServerInfo[]> = Promise.resolve([])

  // MCP 客户端（用于工具调用）
  private clients: Map<string, MCPClient> = new Map()

  constructor() {
    const semaRootDir = getSemaRootDir()
    this.semaUserConfigPath = path.join(semaRootDir, '.mcp.json')

    const cwd = readInitialCwd()
    this.semaProjectConfigPath = path.join(cwd, '.sema', '.mcp.json')

    // 后台静默加载 MCP 配置
    this.refreshMCPServerConfigs().catch(err => {
      logError(`后台加载 MCP 配置失败: ${err}`)
    })
  }

  // ==================== 配置文件读取 ====================

  /**
   * 读取 JSON 文件，失败返回 null
   */
  private readJsonFile(filePath: string): any | null {
    try {
      if (!fs.existsSync(filePath)) return null
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch (err) {
      logError(`读取文件失败 [${filePath}]: ${err}`)
      return null
    }
  }

  /**
   * 读取 mcp 配置文件中的服务器列表
   * 若存在 mcpServers 字段则取该字段，否则读取整个 json
   */
  private readMcpServers(filePath: string): Record<string, any> | null {
    const data = this.readJsonFile(filePath)
    if (!data || typeof data !== 'object') return null
    const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : data
    return expandMcpServers(servers, filePath)
  }

  /**
   * 读取 Sema 项目级 settings.json
   */
  private readSemaSettings(): SemaSettings {
    return readSettings('project')
  }

  /**
   * 写入 Sema 项目级 settings.json（合并写入，保留其他字段）
   */
  private writeSemaSettings(data: SemaSettings): void {
    writeSettings('project', data)
  }

  /**
   * 禁用的 MCP Server 集合：用户级 + 项目级并集（任一层禁用即禁用）
   */
  private readDisabledUnion(): Set<string> {
    const user = readSettings('user').disabledMcpServers ?? []
    const project = readSettings('project').disabledMcpServers ?? []
    return new Set([...user, ...project])
  }

  /**
   * MCP Server 可用工具映射：用户级打底、项目级同名覆盖（与 disabled 同样的分层思路）
   */
  private readUseToolsMerged(): Record<string, string[]> {
    return {
      ...(readSettings('user').enabledMcpServerUseTools ?? {}),
      ...(readSettings('project').enabledMcpServerUseTools ?? {}),
    }
  }

  // ==================== 配置解析 ====================

  /**
   * 解析 Sema 来源的 MCP Server 配置条目
   */
  private parseSemaEntry(name: string, raw: any, scope: MCPScopeType): MCPServerConfig | null {
    const transport = raw.transport || raw.type || 'stdio'
    return {
      name,
      transport,
      description: raw.description,
      command: raw.command,
      args: raw.args,
      env: raw.env,
      url: raw.url,
      headers: raw.headers,
      scope
    }
  }

  /**
   * 创建初始状态的 MCPServerInfo
   */
  private newServerInfo(config: MCPServerConfig, status: boolean, useTools?: string[] | null, filePath?: string): MCPServerInfo {
    let lineRange: string | undefined
    if (filePath && existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const range = findJsonObjectLineRange(raw, `"${config.name}"`)
        lineRange = range ? `${filePath}:${range[0]}-${range[1]}` : filePath
      } catch {
        lineRange = filePath
      }
    }
    return {
      config: { ...config, useTools },
      connectStatus: 'disconnected',
      status,
      scope: config.scope,
      filePath: lineRange
    }
  }

  // ==================== 加载逻辑 ====================

  /**
   * 从已安装且启用的插件中加载 MCP Server 配置
   * MCP server 名格式：plugin:插件名:server名，scope 为 'plugin'
   */
  private async loadMCPsFromPlugins(
    serverMap: Map<string, MCPServerInfo>,
    semaDisabled: Set<string>,
    semaUseToolsMap: Record<string, string[]>
  ): Promise<void> {
    try {
      const { getPluginsManager } = await import('../plugins/pluginsManager')
      const pluginsInfo = await getPluginsManager().getMarketplacePluginsInfo()
      const enabledPlugins = pluginsInfo.plugins.filter(p => p.status)

      let loadedCount = 0
      for (const plugin of enabledPlugins) {
        const mcpComponents = plugin.components.mcp
        if (!Array.isArray(mcpComponents) || mcpComponents.length === 0) continue

        for (const mcpEntry of mcpComponents) {
          const servers = this.readMcpServers(mcpEntry.filePath)
          logDebug(`插件 [${plugin.name}] MCP 文件: ${mcpEntry.filePath}, 配置: ${JSON.stringify(servers)}`)
          if (!servers) continue

          for (const [serverName, raw] of Object.entries<any>(servers)) {
            const pluginServerName = `plugin:${plugin.name}:${serverName}`
            const transport = raw.type || raw.transport || 'stdio'
            const config: MCPServerConfig = {
              name: pluginServerName,
              transport,
              description: raw.description,
              command: raw.command,
              args: raw.args,
              env: raw.env,
              url: raw.url,
              headers: raw.headers,
              scope: 'plugin'
            }
            const status = !semaDisabled.has(pluginServerName)
            const useTools = pluginServerName in semaUseToolsMap ? semaUseToolsMap[pluginServerName] : undefined
            serverMap.set(pluginServerName, this.newServerInfo(config, status, useTools, mcpEntry.filePath))
            loadedCount++
          }
        }
      }

      if (loadedCount > 0) {
        logDebug(`加载插件 MCP: ${loadedCount} 个`)
      }
    } catch (error) {
      logError(`加载插件 MCP 失败: ${error}`)
    }
  }

  /**
   * 加载所有 MCP Server 配置（内部方法）
   * 按优先级加载：插件 -> 用户级 -> 项目级
   * 后加载的覆盖先加载的
   */
  private async loadServers(): Promise<MCPServerInfo[]> {
    const serverMap = new Map<string, MCPServerInfo>()
    const semaDisabled = this.readDisabledUnion()
    const semaUseToolsMap: Record<string, string[]> = this.readUseToolsMerged()

    // 1. 插件 MCP：从已安装且启用的插件中加载 - 最低优先级
    await this.loadMCPsFromPlugins(serverMap, semaDisabled, semaUseToolsMap)

    // 2. Sema 用户级：~/.sema/.mcp.json
    const semaUserServers = this.readMcpServers(this.semaUserConfigPath)
    if (semaUserServers) {
      let count = 0
      for (const [name, raw] of Object.entries<any>(semaUserServers)) {
        const config = this.parseSemaEntry(name, raw, 'user')
        if (config) {
          const useTools = name in semaUseToolsMap ? semaUseToolsMap[name] : undefined
          serverMap.set(name, this.newServerInfo(config, !semaDisabled.has(name), useTools, this.semaUserConfigPath))
          count++
        }
      }
      if (count > 0) logDebug(`加载 Sema 用户级 MCP: ${count} 个`)
    }

    // 3. Sema 项目级：<project>/.sema/.mcp.json（最高优先级）
    const semaProjectServers = this.readMcpServers(this.semaProjectConfigPath)
    if (semaProjectServers) {
      let count = 0
      for (const [name, raw] of Object.entries<any>(semaProjectServers)) {
        const config = this.parseSemaEntry(name, raw, 'project')
        if (config) {
          const useTools = name in semaUseToolsMap ? semaUseToolsMap[name] : undefined
          serverMap.set(name, this.newServerInfo(config, !semaDisabled.has(name), useTools, this.semaProjectConfigPath))
          count++
        }
      }
      if (count > 0) logDebug(`加载 Sema 项目级 MCP: ${count} 个`)
    }

    const serverNames = Array.from(serverMap.keys()).join(', ')
    logInfo(`加载 MCP 配置: ${serverMap.size} 个服务 [${serverNames}]`)

    // 清理 settings.json 中已不存在的 server 记录
    this.cleanupStaleSettings(serverMap)

    // 只返回不发布：由 doRefresh 同步补齐状态后一次性替换缓存
    return Array.from(serverMap.values())
  }

  /**
   * 清理 settings.json 中已不存在的 server 的残留记录
   */
  private cleanupStaleSettings(serverMap: Map<string, MCPServerInfo>): void {
    const settings = this.readSemaSettings()
    let changed = false

    if (settings.disabledMcpServers?.length) {
      const filtered = settings.disabledMcpServers.filter(name => serverMap.has(name))
      if (filtered.length !== settings.disabledMcpServers.length) {
        settings.disabledMcpServers = filtered
        changed = true
      }
    }

    if (settings.enabledMcpServerUseTools) {
      for (const name of Object.keys(settings.enabledMcpServerUseTools)) {
        if (!serverMap.has(name)) {
          delete settings.enabledMcpServerUseTools[name]
          changed = true
        }
      }
    }

    if (changed) {
      this.writeSemaSettings(settings)
      logDebug('已清理 settings.json 中过期的 MCP Server 记录')
    }
  }

  /**
   * 比较两个 MCPServerConfig 的连接相关字段是否相同（不含 useTools）
   */
  private isConfigEqual(a: MCPServerConfig, b: MCPServerConfig): boolean {
    return (
      a.transport === b.transport &&
      a.command === b.command &&
      JSON.stringify(a.args) === JSON.stringify(b.args) &&
      JSON.stringify(a.env) === JSON.stringify(b.env) &&
      a.url === b.url &&
      JSON.stringify(a.headers) === JSON.stringify(b.headers)
    )
  }

  /**
   * 连接单个服务器，更新 serverInfo 的连接状态
   */
  private async connectServer(info: MCPServerInfo): Promise<void> {
    const { name } = info.config
    const eventBus = EventBus.getInstance()
    info.connectStatus = 'connecting'
    info.error = undefined
    eventBus.emit('mcp:server:status', info)
    // 连接期间可能发生过刷新，缓存里已是新建的条目（复制了 connecting 状态），结果要写到当前条目上，
    // 否则界面永远看到 connecting。条目已不存在（被移除或 dispose）、已禁用或配置已变时，这次连接就过期了：
    // 不写缓存、不进 clients
    const target = (): MCPServerInfo | null => {
      const cur = this.serverInfoCache?.find(s => s.config.name === name)
      return cur && cur.status && this.isConfigEqual(cur.config, info.config) ? cur : null
    }
    try {
      await this.disconnectClient(name)
      const client = new MCPClient(info.config)
      await client.connect()
      const cur = target()
      // 开头已清过同名客户端，落地时又出现说明并发连接先落地了：先落地者赢，自己丢弃，避免覆盖与泄漏
      if (!cur || this.clients.has(name)) {
        logDebug(`MCP Server [${name}] 连接完成时条目已变或已有连接落地，丢弃本次连接`)
        await client.disconnect()
        return
      }
      this.clients.set(name, client)
      cur.connectStatus = client.status
      cur.capabilities = client.capabilities ?? undefined
      cur.connectedAt = Date.now()
      cur.error = undefined
      logDebug(`MCP Server [${name}] 连接成功`)
      eventBus.emit('mcp:server:status', cur)
    } catch (err) {
      const cur = target()
      // 条目已变，或已有别的连接落地（同配置的重复连接后失败）：不把 error 写到别人的结果上
      if (!cur || this.clients.has(name)) return
      cur.connectStatus = 'error'
      cur.error = String(err)
      logError(`连接 MCP Server [${name}] 失败: ${err}`)
      eventBus.emit('mcp:server:status', cur)
    }
  }

  /**
   * 断开单个客户端连接
   */
  private async disconnectClient(name: string): Promise<void> {
    const client = this.clients.get(name)
    if (client) {
      try {
        await client.disconnect()
      } catch (err) {
        logError(`断开 MCP Server [${name}] 连接时出错: ${err}`)
      } finally {
        this.clients.delete(name)
      }
    }
  }

  /**
   * 断开所有客户端连接
   */
  private async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.clients.keys()).map(name => this.disconnectClient(name)))
  }

  // ==================== Sema 配置写入 ====================

  /**
   * 读取 Sema MCP 配置文件中的服务器列表（用于写操作）
   * 返回服务器列表及原文件是否使用 mcpServers 包裹格式
   */
  private readSemaMcpConfigFile(configPath: string): { servers: Record<string, any>; hasMcpServersField: boolean } {
    try {
      if (!fs.existsSync(configPath)) return { servers: {}, hasMcpServersField: true }
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (data.mcpServers && typeof data.mcpServers === 'object') {
        return { servers: data.mcpServers, hasMcpServersField: true }
      }
      return { servers: typeof data === 'object' ? data : {}, hasMcpServersField: false }
    } catch {
      return { servers: {}, hasMcpServersField: true }
    }
  }

  /**
   * 写入 Sema MCP 配置文件
   * hasMcpServersField 为 true 时使用 { mcpServers: ... } 包裹格式，否则直接写入
   */
  private writeSemaMcpConfigFile(configPath: string, servers: Record<string, any>, hasMcpServersField = true): void {
    try {
      const dir = path.dirname(configPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const content = hasMcpServersField ? { mcpServers: servers } : servers
      fs.writeFileSync(configPath, JSON.stringify(content, null, 2), 'utf8')
    } catch (err) {
      logError(`写入 MCP 配置文件失败 [${configPath}]: ${err}`)
      throw err
    }
  }

  /**
   * 获取对应 scope 的 Sema MCP 配置文件路径
   */
  private getSemaMcpConfigPath(scope: MCPScopeType): string {
    return scope === 'project' ? this.semaProjectConfigPath : this.semaUserConfigPath
  }

  // ==================== 公共接口 ====================

  /**
   * 初始化 MCP Manager（等待首次加载完成）
   */
  async init(): Promise<void> {
    await this.refreshChain
    if (!this.serverInfoCache) await this.refreshMCPServerConfigs()
  }

  /**
   * 获取所有 MCP Server 信息（有缓存则直接返回，否则等待正在进行的刷新或重新加载）
   */
  async getMCPServerConfigs(): Promise<MCPServerInfo[]> {
    if (this.serverInfoCache) return this.serverInfoCache
    await this.refreshChain
    return this.serverInfoCache ?? this.refreshMCPServerConfigs()
  }

  /**
   * 刷新 MCP Server 信息（串行排队，见 refreshChain）
   * 对比配置变化，仅重连配置有变动或新增的服务器，配置未变且已连接的保留现有连接
   */
  refreshMCPServerConfigs(): Promise<MCPServerInfo[]> {
    const run = this.refreshChain.then(() => this.doRefresh())
    // 链上只记结果，失败不阻断后续刷新；错误由调用方的 run 拿到
    this.refreshChain = run.catch(() => this.serverInfoCache ?? [])
    return run
  }

  private async doRefresh(): Promise<MCPServerInfo[]> {
    logDebug('刷新 MCP Server 信息...')
    const oldCache = this.serverInfoCache ? [...this.serverInfoCache] : null

    // 重新加载配置（不触发连接），此时缓存仍是旧的
    const newCache = await this.loadServers()
    const newNames = new Set(newCache.map(s => s.config.name))

    // 已移除的服务器：稍后断开
    const removedNames = Array.from(this.clients.keys()).filter(name => !newNames.has(name))

    // 对每个新配置判断去向。这一段必须同步：从旧条目继承状态要在发布新缓存之前完成，
    // 发布之后不再回写，否则在途连接在 await 期间写进新缓存的结果会被旧状态盖掉
    const toConnect: MCPServerInfo[] = []
    const toDisconnect: string[] = []
    for (const newInfo of newCache) {
      const name = newInfo.config.name
      const oldInfo = oldCache?.find(s => s.config.name === name)
      const existingClient = this.clients.get(name)

      if (!newInfo.status) {
        // 已禁用 → 断开连接
        if (existingClient) toDisconnect.push(name)
        continue
      }

      if (oldInfo && this.isConfigEqual(oldInfo.config, newInfo.config)) {
        // 配置未变 → 保留现有连接状态（无论成功/失败/未连接）
        newInfo.connectStatus = oldInfo.connectStatus
        newInfo.capabilities = oldInfo.capabilities
        newInfo.connectedAt = oldInfo.connectedAt
        newInfo.error = oldInfo.error
        logDebug(`MCP Server [${name}] 配置未变更，保持现有连接`)
      } else {
        // 新增或配置有变 → 需要重连（connectServer 开头会断开旧客户端）
        toConnect.push(newInfo)
      }
    }

    // 一次性发布新缓存；之后只做断开与连接，状态由 connectServer 写到当前缓存条目上
    this.serverInfoCache = newCache
    await Promise.all([...removedNames, ...toDisconnect].map(name => this.disconnectClient(name)))

    // 后台连接变更/新增的服务器
    for (const info of toConnect) {
      logInfo(`后台连接 MCP Server [${info.config.name}]，原因: ${oldCache?.find(s => s.config.name === info.config.name) ? '配置变更' : '新增'}`)
      this.connectServer(info).catch(err => {
        logError(`后台连接 MCP Server [${info.config.name}] 失败: ${err}`)
      })
    }

    logInfo(`MCP Server 信息刷新完成: ${newCache.length} 个服务，${toConnect.length} 个重连，${removedNames.length} 个移除`)
    return newCache
  }

  /**
   * 获取所有 MCP 工具（同步，基于当前已连接的客户端）
   */
  getMCPTools(): Tool[] {
    const tools: Tool[] = []
    for (const [serverName, client] of this.clients) {
      if (client.status !== 'connected' || !client.capabilities?.tools) continue
      const info = this.serverInfoCache?.find(s => s.config.name === serverName)
      const useTools = info?.config.useTools
      const serverTools = client.capabilities.tools.map(
        toolDef => createMCPToolAdapter(client, serverName, toolDef)
      )
      if (useTools) {
        tools.push(...serverTools.filter(tool => {
          const parts = tool.name.split('__')
          const origName = parts.length >= 3 ? parts.slice(2).join('__') : tool.name
          return useTools.includes(origName)
        }))
      } else {
        tools.push(...serverTools)
      }
    }
    return tools
  }

  /**
   * 添加或更新 MCP Server
   */
  async addMCPServer(config: MCPServerConfig): Promise<MCPServerInfo[]> {
    const configPath = this.getSemaMcpConfigPath(config.scope)
    const { servers, hasMcpServersField } = this.readSemaMcpConfigFile(configPath)
    logDebug(`configPath: ${configPath}, servers: ${servers}, hasMcpServersField: ${hasMcpServersField}`)
    const { name, scope, useTools, ...rest } = config
    servers[name] = rest
    this.writeSemaMcpConfigFile(configPath, servers, hasMcpServersField)
    logInfo(`添加/更新 MCP Server [${config.name}] 到 ${config.scope} 级配置`)
    return this.refreshMCPServerConfigs()
  }

  /**
   * 移除 MCP Server
   */
  async removeMCPServer(name: string): Promise<MCPServerInfo[]> {
    const info = this.serverInfoCache?.find(s => s.config.name === name)
    if (!info) {
      logWarn(`移除 MCP Server 失败: 未找到 [${name}]`)
      return this.getMCPServerConfigs()
    }
    const configPath = this.getSemaMcpConfigPath(info.scope!)
    const { servers, hasMcpServersField } = this.readSemaMcpConfigFile(configPath)
    delete servers[name]
    this.writeSemaMcpConfigFile(configPath, servers, hasMcpServersField)
    // 清理同层 settings 中的禁用/工具列表记录（写入层与 disable/enable 对称，见 toggleScope）
    const settingsScope = this.toggleScope(info)
    const settings = readSettings(settingsScope)
    let settingsChanged = false
    if (settings.disabledMcpServers?.includes(name)) {
      settings.disabledMcpServers = settings.disabledMcpServers.filter(n => n !== name)
      settingsChanged = true
    }
    if (settings.enabledMcpServerUseTools && name in settings.enabledMcpServerUseTools) {
      delete settings.enabledMcpServerUseTools[name]
      settingsChanged = true
    }
    if (settingsChanged) writeSettings(settingsScope, settings)
    await this.disconnectClient(name)
    logInfo(`移除 MCP Server [${name}]`)
    return this.refreshMCPServerConfigs()
  }

  /**
   * 重新连接指定 MCP Server
   */
  async reconnectMCPServer(name: string): Promise<MCPServerInfo[]> {
    const info = this.serverInfoCache?.find(s => s.config.name === name)
    if (!info) {
      logWarn(`重连 MCP Server 失败: 未找到 [${name}]`)
      return this.getMCPServerConfigs()
    }
    // 连接中再点重连会起第二个连接，先完成的客户端没人引用就泄漏了；连接中直接忽略，等这次出结果
    if (info.connectStatus === 'connecting') {
      logInfo(`MCP Server [${name}] 正在连接中，忽略重复的重连请求`)
      return this.getMCPServerConfigs()
    }
    await this.connectServer(info)
    return this.getMCPServerConfigs()
  }

  /**
   * 启停写入哪层 settings：跟随 server 所在层
   * （项目级/local 写项目级，用户级/插件写用户级，即全局生效）
   */
  private toggleScope(info: MCPServerInfo): SettingsScope {
    const s = info.config.scope
    return s === 'project' || s === 'local' ? 'project' : 'user'
  }

  /**
   * 禁用指定 MCP Server
   * 修改 settings.json 的 disabledMcpServers 字段（写入层见 toggleScope）
   */
  async disableMCPServer(name: string): Promise<MCPServerInfo[]> {
    const info = this.serverInfoCache?.find(s => s.config.name === name)
    if (!info) {
      logWarn(`禁用 MCP Server 失败: 未找到 [${name}]`)
      return this.getMCPServerConfigs()
    }
    const scope = this.toggleScope(info)
    const settings = readSettings(scope)
    if (!settings.disabledMcpServers) settings.disabledMcpServers = []
    if (!settings.disabledMcpServers.includes(name)) {
      settings.disabledMcpServers.push(name)
    }
    writeSettings(scope, settings)
    info.status = false
    await this.disconnectClient(name)
    info.connectStatus = 'disconnected'
    info.capabilities = undefined
    logInfo(`禁用 MCP Server [${name}]（${scope} 级）`)
    return this.getMCPServerConfigs()
  }

  /**
   * 启用指定 MCP Server
   * 只从目标层（见 toggleScope）的 disabledMcpServers 移除；若另一层仍禁用，最终仍为禁用
   */
  async enableMCPServer(name: string): Promise<MCPServerInfo[]> {
    const info = this.serverInfoCache?.find(s => s.config.name === name)
    if (!info) {
      logWarn(`启用 MCP Server 失败: 未找到 [${name}]`)
      return this.getMCPServerConfigs()
    }
    const scope = this.toggleScope(info)
    const settings = readSettings(scope)
    if (settings.disabledMcpServers) {
      settings.disabledMcpServers = settings.disabledMcpServers.filter(n => n !== name)
    }
    writeSettings(scope, settings)
    const stillDisabled = this.readDisabledUnion().has(name)
    info.status = !stillDisabled
    if (stillDisabled) {
      logWarn(`MCP Server [${name}] 在另一层 settings 中仍被禁用，未连接`)
    } else {
      await this.connectServer(info)
    }
    logInfo(`启用 MCP Server [${name}]（${scope} 级）`)
    return this.getMCPServerConfigs()
  }

  /**
   * 更新指定 MCP Server 的工具使用列表
   * 修改 settings.json 的 enabledMcpServerUseTools 字段（写入层跟随 server 所在层，见 toggleScope；
   * 生效值为用户级打底、项目级同名覆盖，toolNames 为 null 时删除该层记录=全部可用）
   */
  async updateMCPUseTools(name: string, toolNames: string[] | null): Promise<MCPServerInfo[]> {
    const info = this.serverInfoCache?.find(s => s.config.name === name)
    if (!info) {
      logWarn(`更新工具列表失败: 未找到 MCP Server [${name}]`)
      return this.getMCPServerConfigs()
    }
    const scope = this.toggleScope(info)
    const settings = readSettings(scope)
    if (!settings.enabledMcpServerUseTools) settings.enabledMcpServerUseTools = {}
    // == null 同时兜住 null 与 undefined（SDK 桥的 payload 助手会把 null 键整个略去）
    if (toolNames == null) {
      delete settings.enabledMcpServerUseTools[name]
    } else {
      settings.enabledMcpServerUseTools[name] = toolNames
    }
    writeSettings(scope, settings)
    // 同步更新缓存中的配置（取分层合并后的生效值）
    info.config.useTools = this.readUseToolsMerged()[name] ?? null
    logInfo(`更新 MCP Server [${name}] 工具列表（${scope} 级）: ${toolNames ? toolNames.join(', ') : 'null (使用所有工具)'}`)
    return this.getMCPServerConfigs()
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    await this.disconnectAll()
    this.serverInfoCache = null
  }
}

// ===================== 全局 MCP 管理器 =====================

let mcpManagerInstance: MCPManager | null = null

/**
 * 获取 MCP Manager 实例（单例模式）
 */
export function getMCPManager(): MCPManager {
  if (!mcpManagerInstance) {
    mcpManagerInstance = new MCPManager()
  }
  return mcpManagerInstance
}

/**
 * 初始化 MCP Manager
 * 需要在 readInitialCwd 设置后调用
 */
export async function initMCPManager(): Promise<void> {
  const manager = getMCPManager()
  await manager.init()
}

export { MCPManager }

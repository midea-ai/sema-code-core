/**
 * MCP 管理器
 *
 * 管理 MCP Server 配置，从多个来源加载
 * 实现优先级：用户级(Claude) < 本地级(Claude) < 项目级(Claude) < 用户级(Sema) < 项目级(Sema)
 * 兼容 Claude Code 和 Sema 两套路径（Claude 只读）
 *
 * 状态管理：
 * - Sema 服务启用/禁用：.sema/settings.json -> disabledMcpServers
 * - 可用工具列表：.sema/settings.json -> enabledMcpServerUseTools
 * - Claude 服务禁用：~/.claude.json -> projects[cwd].disabledMcpServers
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { MCPClient } from './MCPClient'
import { createMCPToolAdapter } from './MCPToolAdapter'
import { Tool } from '../../tools/base/Tool'
import { MCPServerConfig, MCPScopeType, MCPServerInfo } from '../../types/mcp'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { EventBus } from '../../events/EventSystem'
import { getSemaRootDir } from '../../util/savePath'
import { getOriginalCwd } from '../../util/cwd'
import { getConfManager } from '../../manager/ConfManager'

/** Sema settings 文件结构（部分） */
interface SemaSettings {
  disabledMcpServers?: string[]
  enabledMcpServerUseTools?: Record<string, string[]>
  [key: string]: any
}

/**
 * MCP 管理器类 - 单例模式
 */
class MCPManager {
  private semaUserConfigPath: string      // ~/.sema/.mcp.json
  private semaProjectConfigPath: string   // <project>/.sema/.mcp.json
  private semaProjectSettingsPath: string // <project>/.sema/settings.json

  private claudeGlobalConfigPath: string  // ~/.claude.json
  private claudeProjectConfigPath: string // <project>/.mcp.json
  private claudeSettingsPath: string      // <project>/.claude/settings.local.json

  // Server 信息缓存
  private serverInfoCache: MCPServerInfo[] | null = null
  // 后台加载 Promise
  private loadingPromise: Promise<MCPServerInfo[]> | null = null

  // MCP 客户端（用于工具调用）
  private clients: Map<string, MCPClient> = new Map()

  constructor() {
    const semaRootDir = getSemaRootDir()
    this.semaUserConfigPath = path.join(semaRootDir, '.mcp.json')

    const cwd = getOriginalCwd()
    this.semaProjectConfigPath = path.join(cwd, '.sema', '.mcp.json')
    this.semaProjectSettingsPath = path.join(cwd, '.sema', 'settings.json')
    this.claudeProjectConfigPath = path.join(cwd, '.mcp.json')
    this.claudeSettingsPath = path.join(cwd, '.claude', 'settings.local.json')

    this.claudeGlobalConfigPath = path.join(os.homedir(), '.claude.json')

    // 后台静默加载 MCP 配置
    this.loadingPromise = this.refreshMCPServerConfigs()
      .catch(err => {
        logError(`后台加载 MCP 配置失败: ${err}`)
        return [] as MCPServerInfo[]
      })
      .finally(() => { this.loadingPromise = null })
  }

  /**
   * 清空缓存
   */
  private invalidateCache(): void {
    this.serverInfoCache = null
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
    if (data.mcpServers && typeof data.mcpServers === 'object') {
      return data.mcpServers
    }
    return data
  }

  /**
   * 读取 Sema 项目级 settings.json
   */
  private readSemaSettings(): SemaSettings {
    try {
      if (!fs.existsSync(this.semaProjectSettingsPath)) return {}
      return JSON.parse(fs.readFileSync(this.semaProjectSettingsPath, 'utf8')) as SemaSettings
    } catch {
      return {}
    }
  }

  /**
   * 写入 Sema 项目级 settings.json（合并写入，保留其他字段）
   */
  private writeSemaSettings(data: SemaSettings): void {
    try {
      const dir = path.dirname(this.semaProjectSettingsPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this.semaProjectSettingsPath, JSON.stringify(data, null, 2), 'utf8')
    } catch (err) {
      logError(`写入 Sema settings 文件失败 [${this.semaProjectSettingsPath}]: ${err}`)
      throw err
    }
  }

  /**
   * 获取 ~/.claude.json 全局配置
   */
  private getClaudeGlobalConfig(): any {
    return this.readJsonFile(this.claudeGlobalConfigPath)
  }

  /**
   * 获取 Claude 中被禁用的 MCP Server 列表
   * ~/.claude.json -> projects[cwd].disabledMcpServers
   */
  private getClaudeDisabledServers(): Set<string> {
    const globalConfig = this.getClaudeGlobalConfig()
    if (!globalConfig) return new Set()
    const cwd = getOriginalCwd()
    const disabled = globalConfig.projects?.[cwd]?.disabledMcpServers
    return new Set(Array.isArray(disabled) ? disabled : [])
  }

  /**
   * 获取 Claude 项目级 MCP 启用设置
   * <project>/.claude/settings.local.json
   */
  private getClaudeProjectSettings(): { enableAll: boolean; enabled: Set<string> } {
    const data = this.readJsonFile(this.claudeSettingsPath)
    if (!data) return { enableAll: false, enabled: new Set() }
    return {
      enableAll: data.enableAllProjectMcpServers === true,
      enabled: new Set(Array.isArray(data.enabledMcpjsonServers) ? data.enabledMcpjsonServers : [])
    }
  }

  // ==================== 配置解析 ====================

  /**
   * 解析 Claude 来源的 MCP Server 配置条目
   */
  private parseClaudeEntry(name: string, raw: any, scope: MCPScopeType): MCPServerConfig | null {
    const transport = raw.type || raw.transport || 'stdio'
    return {
      name,
      transport,
      description: raw.description,
      command: raw.command,
      args: raw.args,
      env: raw.env,
      url: raw.url,
      headers: raw.headers,
      from: 'claude',
      scope
    }
  }

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
      from: 'sema',
      scope
    }
  }

  /**
   * 创建初始状态的 MCPServerInfo
   */
  private newServerInfo(config: MCPServerConfig, status: boolean, useTools?: string[] | null, filePath?: string): MCPServerInfo {
    return {
      config: { ...config, useTools },
      connectStatus: 'disconnected',
      status,
      from: config.from,
      scope: config.scope,
      filePath
    }
  }

  // ==================== 加载逻辑 ====================

  /**
   * 从已安装且启用的插件中加载 MCP Server 配置
   * MCP server 名格式：plugin:插件名:server名，scope 为 'plugin'
   * 状态由 ~/.claude.json -> projects[cwd].disabledMcpServers 决定
   */
  private async loadMCPsFromPlugins(
    serverMap: Map<string, MCPServerInfo>,
    claudeDisabled: Set<string>,
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
              from: plugin.from,
              scope: 'plugin'
            }
            const status = !claudeDisabled.has(pluginServerName) && !semaDisabled.has(pluginServerName)
            // claude 来源的插件 MCP，若已被 claude 禁用则跳过
            if (plugin.from === 'claude' && claudeDisabled.has(pluginServerName)) continue
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
   * 按优先级加载：用户级(Claude) -> 本地级(Claude) -> 项目级(Claude) -> 插件 -> 用户级(Sema) -> 项目级(Sema)
   * 后加载的覆盖先加载的，优先级从高到低：项目级(Sema) > 用户级(Sema) > 插件 > 项目级(Claude) > 本地级(Claude) > 用户级(Claude)
   */
  private async loadServers(): Promise<void> {
    const serverMap = new Map<string, MCPServerInfo>()
    const enableClaudeCodeCompat = getConfManager().getCoreConfig()?.enableClaudeCodeCompat !== false
    const claudeDisabled = enableClaudeCodeCompat ? this.getClaudeDisabledServers() : new Set<string>()
    const claudeProjectSettings = enableClaudeCodeCompat ? this.getClaudeProjectSettings() : { enableAll: false, enabled: new Set<string>() }
    const claudeGlobal = enableClaudeCodeCompat ? this.getClaudeGlobalConfig() : null
    const semaSettings = this.readSemaSettings()
    const semaDisabled = new Set<string>(semaSettings.disabledMcpServers ?? [])
    const semaUseToolsMap: Record<string, string[]> = semaSettings.enabledMcpServerUseTools ?? {}

    // 1. Claude 用户级：~/.claude.json -> mcpServers
    if (enableClaudeCodeCompat && claudeGlobal?.mcpServers && typeof claudeGlobal.mcpServers === 'object') {
      let count = 0
      for (const [name, raw] of Object.entries<any>(claudeGlobal.mcpServers)) {
        const config = this.parseClaudeEntry(name, raw, 'user')
        if (config) {
          const useTools = name in semaUseToolsMap ? semaUseToolsMap[name] : undefined
          serverMap.set(name, this.newServerInfo(config, !claudeDisabled.has(name) && !semaDisabled.has(name), useTools, this.claudeGlobalConfigPath))
          count++
        }
      }
      if (count > 0) logDebug(`加载 Claude 用户级 MCP: ${count} 个`)
    }

    // 2. Claude 本地级：~/.claude.json -> projects[cwd].mcpServers
    const cwd = getOriginalCwd()
    if (enableClaudeCodeCompat) {
      const localServers = claudeGlobal?.projects?.[cwd]?.mcpServers
      if (localServers && typeof localServers === 'object') {
        let count = 0
        for (const [name, raw] of Object.entries<any>(localServers)) {
          const config = this.parseClaudeEntry(name, raw, 'local')
          if (config) {
            const useTools = name in semaUseToolsMap ? semaUseToolsMap[name] : undefined
            serverMap.set(name, this.newServerInfo(config, !claudeDisabled.has(name) && !semaDisabled.has(name), useTools, this.claudeGlobalConfigPath))
            count++
          }
        }
        if (count > 0) logDebug(`加载 Claude 本地级 MCP: ${count} 个`)
      }
    }

    // 3. Claude 项目级：<project>/.mcp.json
    // 需要 enableAllProjectMcpServers 为 true 且在 enabledMcpjsonServers 中才生效
    if (enableClaudeCodeCompat) {
      const claudeProjectServers = this.readMcpServers(this.claudeProjectConfigPath)
      if (claudeProjectServers) {
        let count = 0
        for (const [name, raw] of Object.entries<any>(claudeProjectServers)) {
          const config = this.parseClaudeEntry(name, raw, 'project')
          if (config) {
            const status = !claudeDisabled.has(name)
              && !semaDisabled.has(name)
              && claudeProjectSettings.enableAll
              && claudeProjectSettings.enabled.has(name)
            const useTools = name in semaUseToolsMap ? semaUseToolsMap[name] : undefined
            serverMap.set(name, this.newServerInfo(config, status, useTools, this.claudeProjectConfigPath))
            count++
          }
        }
        if (count > 0) logDebug(`加载 Claude 项目级 MCP: ${count} 个`)
      }
    }

    // 4. 插件 MCP：从已安装且启用的插件中加载
    await this.loadMCPsFromPlugins(serverMap, claudeDisabled, semaDisabled, semaUseToolsMap)

    // 5. Sema 用户级：~/.sema/.mcp.json
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

    // 6. Sema 项目级：<project>/.sema/.mcp.json（最高优先级）
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

    this.serverInfoCache = Array.from(serverMap.values())
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
    eventBus.emit('mcp:server:status', info)
    try {
      await this.disconnectClient(name)
      const client = new MCPClient(info.config)
      await client.connect()
      this.clients.set(name, client)
      info.connectStatus = client.status
      info.capabilities = client.capabilities ?? undefined
      info.connectedAt = Date.now()
      logDebug(`MCP Server [${name}] 连接成功`)
      eventBus.emit('mcp:server:status', info)
    } catch (err) {
      info.connectStatus = 'error'
      info.error = String(err)
      logError(`连接 MCP Server [${name}] 失败: ${err}`)
      eventBus.emit('mcp:server:status', info)
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
    if (this.loadingPromise) {
      await this.loadingPromise
    } else if (!this.serverInfoCache) {
      await this.refreshMCPServerConfigs()
    }
  }

  /**
   * 获取所有 MCP Server 信息（有缓存则直接返回，否则等待后台加载或重新加载）
   */
  async getMCPServerConfigs(): Promise<MCPServerInfo[]> {
    if (this.serverInfoCache) return this.serverInfoCache
    if (this.loadingPromise) return this.loadingPromise
    return this.refreshMCPServerConfigs()
  }

  /**
   * 刷新 MCP Server 信息
   * 对比配置变化，仅重连配置有变动或新增的服务器，配置未变且已连接的保留现有连接
   */
  async refreshMCPServerConfigs(): Promise<MCPServerInfo[]> {
    logDebug('刷新 MCP Server 信息...')
    const oldCache = this.serverInfoCache ? [...this.serverInfoCache] : null

    // 重新加载配置（不触发连接）
    this.invalidateCache()
    await this.loadServers()

    const newCache = this.serverInfoCache!
    const newNames = new Set(newCache.map(s => s.config.name))

    // 断开已移除的服务器
    const removedNames = Array.from(this.clients.keys()).filter(name => !newNames.has(name))
    await Promise.all(removedNames.map(name => this.disconnectClient(name)))

    // 对每个新配置，判断是否需要重连
    const toConnect: MCPServerInfo[] = []
    for (const newInfo of newCache) {
      const name = newInfo.config.name
      const oldInfo = oldCache?.find(s => s.config.name === name)
      const existingClient = this.clients.get(name)

      if (!newInfo.status) {
        // 已禁用 → 断开连接
        if (existingClient) {
          await this.disconnectClient(name)
          newInfo.connectStatus = 'disconnected'
          newInfo.capabilities = undefined
        }
        continue
      }

      if (oldInfo && this.isConfigEqual(oldInfo.config, newInfo.config)) {
        // 配置未变 → 保留现有连接状态（无论成功/失败/未连接）
        newInfo.connectStatus = oldInfo.connectStatus
        newInfo.capabilities = oldInfo.capabilities
        newInfo.connectedAt = oldInfo.connectedAt
        logDebug(`MCP Server [${name}] 配置未变更，保持现有连接`)
      } else {
        // 新增或配置有变 → 需要重连
        if (existingClient) await this.disconnectClient(name)
        toConnect.push(newInfo)
      }
    }

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
    const { name, from, scope, useTools, ...rest } = config
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
    if (info.from === 'claude') {
      logWarn(`移除 MCP Server 失败: Claude 来源为只读 [${name}]`)
      return this.getMCPServerConfigs()
    }
    const configPath = this.getSemaMcpConfigPath(info.scope!)
    const { servers, hasMcpServersField } = this.readSemaMcpConfigFile(configPath)
    delete servers[name]
    this.writeSemaMcpConfigFile(configPath, servers, hasMcpServersField)
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
    await this.connectServer(info)
    return this.getMCPServerConfigs()
  }

  /**
   * 禁用指定 MCP Server
   * 修改 .sema/settings.json 的 disabledMcpServers 字段
   */
  async disableMCPServer(name: string): Promise<MCPServerInfo[]> {
    const info = this.serverInfoCache?.find(s => s.config.name === name)
    if (!info) {
      logWarn(`禁用 MCP Server 失败: 未找到 [${name}]`)
      return this.getMCPServerConfigs()
    }
    // if (info.from === 'claude') {
    //   logWarn(`禁用 MCP Server 失败: Claude 来源为只读 [${name}]`)
    //   return this.getMCPServerConfigs()
    // }
    const settings = this.readSemaSettings()
    if (!settings.disabledMcpServers) settings.disabledMcpServers = []
    if (!settings.disabledMcpServers.includes(name)) {
      settings.disabledMcpServers.push(name)
    }
    this.writeSemaSettings(settings)
    info.status = false
    await this.disconnectClient(name)
    info.connectStatus = 'disconnected'
    info.capabilities = undefined
    logInfo(`禁用 MCP Server [${name}]`)
    return this.getMCPServerConfigs()
  }

  /**
   * 启用指定 MCP Server
   * 修改 .sema/settings.json 的 disabledMcpServers 字段
   */
  async enableMCPServer(name: string): Promise<MCPServerInfo[]> {
    const info = this.serverInfoCache?.find(s => s.config.name === name)
    if (!info) {
      logWarn(`启用 MCP Server 失败: 未找到 [${name}]`)
      return this.getMCPServerConfigs()
    }
    // if (info.from === 'claude') {
    //   logWarn(`启用 MCP Server 失败: Claude 来源为只读 [${name}]`)
    //   return this.getMCPServerConfigs()
    // }
    const settings = this.readSemaSettings()
    if (settings.disabledMcpServers) {
      settings.disabledMcpServers = settings.disabledMcpServers.filter(n => n !== name)
    }
    this.writeSemaSettings(settings)
    info.status = true
    await this.connectServer(info)
    logInfo(`启用 MCP Server [${name}]`)
    return this.getMCPServerConfigs()
  }

  /**
   * 更新指定 MCP Server 的工具使用列表
   * 修改 .sema/settings.json 的 enabledMcpServerUseTools 字段
   */
  async updateMCPUseTools(name: string, toolNames: string[] | null): Promise<MCPServerInfo[]> {
    const info = this.serverInfoCache?.find(s => s.config.name === name)
    if (!info) {
      logWarn(`更新工具列表失败: 未找到 MCP Server [${name}]`)
      return this.getMCPServerConfigs()
    }
    const settings = this.readSemaSettings()
    if (!settings.enabledMcpServerUseTools) settings.enabledMcpServerUseTools = {}
    if (toolNames === null) {
      delete settings.enabledMcpServerUseTools[name]
    } else {
      settings.enabledMcpServerUseTools[name] = toolNames
    }
    this.writeSemaSettings(settings)
    // 同步更新缓存中的配置
    info.config.useTools = toolNames
    logInfo(`更新 MCP Server [${name}] 工具列表: ${toolNames ? toolNames.join(', ') : 'null (使用所有工具)'}`)
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
 * 需要在 getOriginalCwd 设置后调用
 */
export async function initMCPManager(): Promise<void> {
  const manager = getMCPManager()
  await manager.init()
}

export { MCPManager }

import * as fs from 'fs'
import * as path from 'path'
import { MCPClient } from './MCPClient'
import { createMCPToolAdapter } from './MCPToolAdapter'
import { Tool } from '../../tools/base/Tool'
import { MCPServerConfig, MCPScopeType, MCPServerInfo, MCPServerStatus } from '../../types/mcp'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getGlobalMCPFilePath } from '../../util/savePath'
import { getOriginalCwd } from '../../util/cwd'

/**
 * MCP 配置文件格式
 */
interface MCPConfigFile {
  mcpServers?: {
    [serverName: string]: MCPServerConfig
  }
}

/**
 * 工具缓存
 * toolsByServer: 按服务器名称分组存储工具，支持增量更新
 */
interface ToolsCache {
  globalMtime: number
  projectMtime: number
  toolsByServer: Map<string, Tool[]>
}

/**
 * MCP 管理器 - 单例模式
 * 管理全局和项目级别的 MCP Server 配置
 */
class MCPManager {
  private globalConfigPath: string
  private projectConfigPath: string
  private globalConfigs: Map<string, MCPServerConfig> = new Map()
  private projectConfigs: Map<string, MCPServerConfig> = new Map()

  // 工具缓存
  private toolsCache: ToolsCache | null = null
  // 客户端缓存（用于工具调用）
  private clients: Map<string, MCPClient> = new Map()
  // ServerInfo 缓存（避免重复构建）
  private serverInfoCache: Map<MCPScopeType, MCPServerInfo[]> | null = null

  constructor(globalConfigPath: string, projectConfigPath: string) {
    this.globalConfigPath = globalConfigPath
    this.projectConfigPath = projectConfigPath
  }

  /**
   * 初始化 MCP 配置
   * 从全局和项目配置文件读取配置，并连接所有服务加载工具
   */
  async init(): Promise<void> {
    // 加载全局配置
    this.globalConfigs = this.loadConfigFile(this.globalConfigPath)

    // 加载项目配置
    this.projectConfigs = this.loadConfigFile(this.projectConfigPath)
    
    logInfo(`加载全局 MCP 配置: ${this.globalConfigs.size} 个服务，项目 MCP 配置: ${this.projectConfigs.size} 个服务`)

    // 连接所有服务并缓存工具
    await this.refreshTools()
  }

  /**
   * 从配置文件加载配置
   * 若文件不存在则创建默认空配置
   */
  private loadConfigFile(configPath: string): Map<string, MCPServerConfig> {
    const configs = new Map<string, MCPServerConfig>()

    try {
      if (!fs.existsSync(configPath)) {
        // 文件不存在，创建默认空配置
        this.ensureConfigFile(configPath)
        return configs
      }

      const content = fs.readFileSync(configPath, 'utf8')
      const configData: MCPConfigFile = JSON.parse(content)

      // 从 mcpServers 字段读取配置
      const serversData = configData.mcpServers || {}

      // 过滤并加载可用的配置
      for (const [name, config] of Object.entries(serversData)) {
        if (this.isValidConfig(config)) {
          configs.set(name, { ...config, name })
        } else {
          logWarn(`MCP Server [${name}] 配置无效，已跳过`)
        }
      }
    } catch (error) {
      logError(`加载 MCP 配置文件失败 [${configPath}]: ${error}`)
    }

    return configs
  }

  /**
   * 确保配置文件存在，若不存在则创建
   */
  private ensureConfigFile(configPath: string): void {
    try {
      const configDir = path.dirname(configPath)
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }
      // 创建空配置文件，使用新格式
      fs.writeFileSync(configPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8')
      logDebug(`创建 MCP 配置文件: ${configPath}`)
    } catch (error) {
      logError(`创建 MCP 配置文件失败 [${configPath}]: ${error}`)
    }
  }

  /**
   * 验证配置是否有效
   */
  private isValidConfig(config: MCPServerConfig): boolean {
    // 基本验证
    if (!config.transport) {
      return false
    }

    // 根据传输类型验证必要字段
    switch (config.transport) {
      case 'stdio':
        return !!config.command
      case 'sse':
      case 'http':
        return !!config.url
      default:
        return false
    }
  }

  /**
   * 添加或更新 MCP Server 配置
   */
  async addOrUpdateServer(config: MCPServerConfig, scope: MCPScopeType): Promise<MCPServerInfo> {
    const targetConfigs = scope === 'project' ? this.projectConfigs : this.globalConfigs
    const configPath = scope === 'project' ? this.projectConfigPath : this.globalConfigPath

    const isUpdate = targetConfigs.has(config.name)
    targetConfigs.set(config.name, config)

    // 保存到配置文件
    this.saveConfigFile(configPath, targetConfigs)

    logDebug(`${isUpdate ? '更新' : '添加'} MCP Server [${config.name}] 到 ${scope} 配置`)

    // 如果是更新，先断开旧连接并移除旧工具
    if (isUpdate) {
      await this.disconnectClient(config.name)
      if (this.toolsCache) {
        this.toolsCache.toolsByServer.delete(config.name)
      }
    }

    // 如果缓存不存在，初始化一个空缓存
    if (!this.toolsCache) {
      this.toolsCache = {
        globalMtime: this.getFileMtime(this.globalConfigPath),
        projectMtime: this.getFileMtime(this.projectConfigPath),
        toolsByServer: new Map()
      }
    }

    // 只连接新服务器（增量更新）
    if (config.enabled !== false) {
      await this.connectSingleServer(config.name, config)
    }

    // 更新 ServerInfo 缓存并获取服务器信息
    const serverInfo = this.updateServerInfoCache(config.name, scope, isUpdate ? 'update' : 'add')

    // 打印工具统计
    this.logToolStats()

    // 返回该服务器的信息，如果缓存更新失败则重新构建
    return serverInfo || this.buildServerInfo(config.name, config)
  }

  /**
   * 移除 MCP Server 配置
   */
  async removeServer(name: string, scope: MCPScopeType): Promise<boolean> {
    const targetConfigs = scope === 'project' ? this.projectConfigs : this.globalConfigs
    const configPath = scope === 'project' ? this.projectConfigPath : this.globalConfigPath

    if (!targetConfigs.has(name)) {
      logWarn(`MCP Server [${name}] 在 ${scope} 配置中不存在`)
      return false
    }

    // 断开客户端连接
    await this.disconnectClient(name)

    // 只移除该服务器的工具（增量删除）
    if (this.toolsCache) {
      this.toolsCache.toolsByServer.delete(name)
    }

    targetConfigs.delete(name)
    this.saveConfigFile(configPath, targetConfigs)

    logDebug(`移除 MCP Server [${name}] 从 ${scope} 配置`)

    // 更新 ServerInfo 缓存
    this.updateServerInfoCache(name, scope, 'remove')

    // 打印工具统计
    this.logToolStats()

    // 返回成功标志
    return true
  }

  /**
   * 打印当前所有 MCP 工具统计（过滤后的工具数）
   */
  private logToolStats(): void {
    if (!this.toolsCache) return
    const toolStats: Record<string, number> = {}
    const mergedConfigs = this.getMergedConfigs()

    for (const [serverName, tools] of this.toolsCache.toolsByServer) {
      const config = mergedConfigs.get(serverName)
      const filteredTools = this.filterToolsByConfig(tools, config?.useTools)
      toolStats[serverName] = filteredTools.length
    }

    logInfo(`MCP 工具统计 (过滤后): ${JSON.stringify(toolStats)}`)
  }

  /**
   * 保存配置到文件
   */
  private saveConfigFile(configPath: string, configs: Map<string, MCPServerConfig>): void {
    try {
      const configDir = path.dirname(configPath)
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }

      // 构建 mcpServers 对象
      const serversData: Record<string, MCPServerConfig> = {}
      for (const [name, config] of configs) {
        // 保存时去除 name 字段（因为 key 就是 name）
        const { name: _, ...configWithoutName } = config
        serversData[name] = configWithoutName as MCPServerConfig
      }

      // 包装在 mcpServers 字段中
      const configData: MCPConfigFile = { mcpServers: serversData }

      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8')
    } catch (error) {
      logError(`保存 MCP 配置文件失败 [${configPath}]: ${error}`)
      throw error
    }
  }

  /**
   * 获取配置文件的修改时间戳
   */
  private getFileMtime(filePath: string): number {
    try {
      if (fs.existsSync(filePath)) {
        return fs.statSync(filePath).mtimeMs
      }
    } catch {
      // 忽略错误
    }
    return 0
  }

  /**
   * 检查缓存是否有效
   */
  private isCacheValid(): boolean {
    if (!this.toolsCache) {
      return false
    }

    const globalMtime = this.getFileMtime(this.globalConfigPath)
    const projectMtime = this.getFileMtime(this.projectConfigPath)

    return (
      this.toolsCache.globalMtime === globalMtime &&
      this.toolsCache.projectMtime === projectMtime
    )
  }

  /**
   * 获取合并后的配置（项目级优先）
   * 过滤掉 enabled === false 的配置
   */
  private getMergedConfigs(): Map<string, MCPServerConfig> {
    const merged = new Map<string, MCPServerConfig>()

    // 先添加全局配置
    for (const [name, config] of this.globalConfigs) {
      merged.set(name, config)
    }

    // 项目配置覆盖全局配置
    for (const [name, config] of this.projectConfigs) {
      merged.set(name, config)
    }

    // 过滤掉 enabled === false 的配置
    for (const [name, config] of merged) {
      if (config.enabled === false) {
        merged.delete(name)
      }
    }

    return merged
  }

  /**
   * 刷新工具缓存（异步）
   * 重新加载配置并并行连接所有服务
   */
  async refreshTools(): Promise<void> {
    // 检查缓存是否有效
    if (this.isCacheValid()) {
      return
    }

    // 重新加载配置文件（可能被外部修改）
    this.globalConfigs = this.loadConfigFile(this.globalConfigPath)
    this.projectConfigs = this.loadConfigFile(this.projectConfigPath)

    // 获取合并后的配置
    const mergedConfigs = this.getMergedConfigs()

    // 并行连接所有服务并获取工具
    const connectionPromises = Array.from(mergedConfigs.entries()).map(
      async ([name, config]): Promise<{ name: string; tools: Tool[] } | null> => {
        try {
          const client = await this.getOrCreateClient(name, config)
          if (client && client.capabilities?.tools) {
            const tools = client.capabilities.tools.map(
              toolDef => createMCPToolAdapter(client, name, toolDef)
            )
            return { name, tools }
          }
        } catch (error) {
          logError(`获取 MCP Server [${name}] 工具失败: ${error}`)
        }
        return null
      }
    )

    const results = await Promise.all(connectionPromises)

    // 构建按服务器分组的工具缓存
    const toolsByServer = new Map<string, Tool[]>()
    for (const result of results) {
      if (result) {
        toolsByServer.set(result.name, result.tools)
      }
    }

    // 更新工具缓存
    this.toolsCache = {
      globalMtime: this.getFileMtime(this.globalConfigPath),
      projectMtime: this.getFileMtime(this.projectConfigPath),
      toolsByServer
    }

    // 重建 ServerInfo 缓存（连接状态已更新）
    this.rebuildServerInfoCache()

    // 打印工具统计
    this.logToolStats()
  }

  /**
   * 根据 useTools 配置过滤工具
   */
  private filterToolsByConfig(tools: Tool[], useTools: string[] | null | undefined): Tool[] {
    // 如果 useTools 为 null 或 undefined，返回所有工具
    if (!useTools) {
      return tools
    }

    // 根据 disabledTools 过滤工具（disabledTools 存储的是原始工具名，不含前缀）
    return tools.filter(tool => {
      // tool.name 格式为 mcp__serverName__toolName，需要提取 toolName
      const parts = tool.name.split('__')
      const originalToolName = parts.length >= 3 ? parts.slice(2).join('__') : tool.name
      return useTools.includes(originalToolName)
    })
  }

  /**
   * 获取所有 MCP 工具（同步，返回缓存）
   * 合并所有服务器的工具列表，并根据每个服务器的 useTools 配置过滤
   */
  getMCPTools(): Tool[] {
    if (!this.toolsCache) return []

    const result: Tool[] = []
    const mergedConfigs = this.getMergedConfigs()

    for (const [serverName, tools] of this.toolsCache.toolsByServer) {
      const config = mergedConfigs.get(serverName)
      const filteredTools = this.filterToolsByConfig(tools, config?.useTools)
      result.push(...filteredTools)
    }

    return result
  }

  /**
   * 获取或创建客户端连接
   */
  private async getOrCreateClient(
    name: string,
    config: MCPServerConfig
  ): Promise<MCPClient | null> {
    // 检查是否已有连接
    let client = this.clients.get(name)
    if (client && client.status === 'connected') {
      return client
    }

    // 创建新连接
    client = new MCPClient(config)
    try {
      await client.connect()
      this.clients.set(name, client)
      // logDebug(`MCP Server [${name}] 连接成功`)
      return client
    } catch (error) {
      // logError(`MCP Server [${name}] 连接失败: ${error}`)
      return null
    }
  }

  /**
   * 断开客户端连接
   */
  private async disconnectClient(name: string): Promise<void> {
    const client = this.clients.get(name)
    if (client) {
      try {
        await client.disconnect()
      } catch (error) {
        // 记录错误但不影响清理流程
        logError(`断开 MCP Server [${name}] 连接时出错: ${error}`)
      } finally {
        // 无论断开是否成功，都要从缓存中移除
        this.clients.delete(name)
      }
    }
  }

  /**
   * 连接单个服务器并更新工具缓存（增量更新）
   */
  private async connectSingleServer(name: string, config: MCPServerConfig): Promise<void> {
    try {
      const client = await this.getOrCreateClient(name, config)
      if (client && client.capabilities?.tools) {
        const tools: Tool[] = client.capabilities.tools.map(
          toolDef => createMCPToolAdapter(client, name, toolDef)
        )
        // 增量更新工具缓存
        if (this.toolsCache) {
          this.toolsCache.toolsByServer.set(name, tools)
        }
        logInfo(`MCP Server [${name}] 加载了 ${tools.length} 个工具`)
      }
    } catch (error) {
      logError(`连接 MCP Server [${name}] 失败: ${error}`)
    }
  }

  /**
   * 构建单个服务器的 ServerInfo
   */
  private buildServerInfo(name: string, config: MCPServerConfig): MCPServerInfo {
    const client = this.clients.get(name)
    return {
      config,
      status: client?.status ?? 'disconnected',
      capabilities: client?.capabilities ?? undefined,
      error: undefined,
      connectedAt: undefined
    }
  }

  /**
   * 重建 ServerInfo 缓存
   */
  private rebuildServerInfoCache(): void {
    const cache = new Map<MCPScopeType, MCPServerInfo[]>()

    // user scope
    const userServers = Array.from(this.globalConfigs.entries()).map(
      ([name, config]) => this.buildServerInfo(name, config)
    )
    cache.set('user', userServers)

    // project scope
    const projectServers = Array.from(this.projectConfigs.entries()).map(
      ([name, config]) => this.buildServerInfo(name, config)
    )
    cache.set('project', projectServers)

    this.serverInfoCache = cache
  }

  /**
   * 更新单个服务器的 ServerInfo 缓存
   */
  private updateServerInfoCache(name: string, scope: MCPScopeType, action: 'add' | 'remove' | 'update'): MCPServerInfo | null {
    if (!this.serverInfoCache) {
      this.rebuildServerInfoCache()
      // 重建后再次尝试获取
      if (!this.serverInfoCache) return null
    }

    const scopeKey = scope === 'project' ? 'project' : 'user'
    const targetConfigs = scope === 'project' ? this.projectConfigs : this.globalConfigs
    const servers = this.serverInfoCache.get(scopeKey) || []

    if (action === 'remove') {
      // 移除指定服务器
      this.serverInfoCache.set(scopeKey, servers.filter(s => s.config.name !== name))
      return null
    } else {
      // add 或 update：先移除旧的，再添加新的
      const filtered = servers.filter(s => s.config.name !== name)
      const config = targetConfigs.get(name)
      if (config) {
        const serverInfo = this.buildServerInfo(name, config)
        filtered.push(serverInfo)
        this.serverInfoCache.set(scopeKey, filtered)
        return serverInfo
      }
    }
    return null
  }

  /**
   * 获取指定范围的 MCP Server 详细信息
   */
  private getServerInfoByScope(scope: MCPScopeType): MCPServerInfo[] {
    if (!this.serverInfoCache) {
      this.rebuildServerInfoCache()
    }
    const scopeKey = scope === 'project' ? 'project' : 'user'
    return this.serverInfoCache!.get(scopeKey) || []
  }

  /**
   * 获取所有 MCP Server 的详细信息，按范围分组
   */
  getMCPServerConfigs(): Map<MCPScopeType, MCPServerInfo[]> {
    if (!this.serverInfoCache) {
      this.rebuildServerInfoCache()
    }
    return this.serverInfoCache!
  }

  /**
   * 获取全局配置
   */
  getGlobalConfigs(): MCPServerConfig[] {
    return Array.from(this.globalConfigs.values())
  }

  /**
   * 获取项目配置
   */
  getProjectConfigs(): MCPServerConfig[] {
    return Array.from(this.projectConfigs.values())
  }

  /**
   * 更新指定 MCP Server 的工具使用列表
   */
  updateMCPUseTools(name: string, toolNames: string[] | null): boolean {
    // 先从项目配置中查找，再从全局配置中查找
    let config = this.projectConfigs.get(name)
    let scope: MCPScopeType = 'project'
    let configPath = this.projectConfigPath

    if (!config) {
      config = this.globalConfigs.get(name)
      scope = 'user'
      configPath = this.globalConfigPath
    }

    if (!config) {
      logWarn(`MCP Server [${name}] 不存在`)
      return false
    }

    // 更新配置
    const updatedConfig: MCPServerConfig = {
      ...config,
      useTools: toolNames
    }

    // 更新内存中的配置
    if (scope === 'project') {
      this.projectConfigs.set(name, updatedConfig)
    } else {
      this.globalConfigs.set(name, updatedConfig)
    }

    // 保存到配置文件
    const targetConfigs = scope === 'project' ? this.projectConfigs : this.globalConfigs
    this.saveConfigFile(configPath, targetConfigs)

    // 更新 ServerInfo 缓存
    this.updateServerInfoCache(name, scope, 'update')

    logInfo(`MCP Server [${name}] 工具列表已更新: ${toolNames ? toolNames.join(', ') : 'null (使用所有工具)'}`)

    return true
  }

  /**
   * 连接指定的 MCP Server
   */
  async connectMCPServer(name: string): Promise<MCPServerInfo> {
    // 从合并配置中查找服务器配置
    const mergedConfigs = this.getMergedConfigs()
    const config = mergedConfigs.get(name)

    if (!config) {
      logWarn(`MCP Server [${name}] 不存在或已禁用`)
      throw new Error(`MCP Server [${name}] 不存在或已禁用`)
    }

    // 检查当前连接状态
    const existingClient = this.clients.get(name)
    if (existingClient && existingClient.status === 'connected') {
      logInfo(`MCP Server [${name}] 已经连接`)
      // 获取当前服务器信息并返回
      const scope: MCPScopeType = this.projectConfigs.has(name) ? 'project' : 'user'
      const serverInfo = this.updateServerInfoCache(name, scope, 'update')
      return serverInfo || this.buildServerInfo(name, config)
    }

    try {
      // 只有非连接状态才尝试连接
      const client = await this.getOrCreateClient(name, config)

      if (client && client.status === 'connected') {
        // 连接成功，更新工具缓存
        if (client.capabilities?.tools) {
          const tools: Tool[] = client.capabilities.tools.map(
            toolDef => createMCPToolAdapter(client, name, toolDef)
          )

          // 确保工具缓存存在
          if (!this.toolsCache) {
            this.toolsCache = {
              globalMtime: this.getFileMtime(this.globalConfigPath),
              projectMtime: this.getFileMtime(this.projectConfigPath),
              toolsByServer: new Map()
            }
          }

          // 更新工具缓存
          this.toolsCache.toolsByServer.set(name, tools)
          logInfo(`MCP Server [${name}] 连接成功，加载了 ${tools.length} 个工具`)
        }

        // 更新 ServerInfo 缓存
        const scope: MCPScopeType = this.projectConfigs.has(name) ? 'project' : 'user'
        const serverInfo = this.updateServerInfoCache(name, scope, 'update')

        return serverInfo || this.buildServerInfo(name, config)
      } else {
        logError(`MCP Server [${name}] 连接失败`)
        // 返回连接失败的服务器信息
        return this.buildServerInfo(name, config)
      }
    } catch (error) {
      logError(`连接 MCP Server [${name}] 时出错: ${error}`)
      // 返回错误状态的服务器信息
      return this.buildServerInfo(name, config)
    }
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    // 断开所有客户端连接
    const disconnectPromises = Array.from(this.clients.keys()).map(name =>
      this.disconnectClient(name)
    )
    await Promise.all(disconnectPromises)

    this.globalConfigs.clear()
    this.projectConfigs.clear()
    this.toolsCache = null
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
    const globalConfigPath = getGlobalMCPFilePath()
    const originalCwd = getOriginalCwd()
    const projectConfigPath = path.join(originalCwd, '.sema', 'mcp.json')

    mcpManagerInstance = new MCPManager(globalConfigPath, projectConfigPath)
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

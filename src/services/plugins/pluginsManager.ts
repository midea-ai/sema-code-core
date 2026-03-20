/**
 * Plugins 管理器
 *
 * 管理市场插件的全局注册、安装、启用/禁用等
 * 单例模式
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getSemaRootDir, getClaudeRootDir } from '../../util/savePath'
import { getOriginalCwd } from '../../util/cwd'
import { getConfManager } from '../../manager/ConfManager'
import { execFileNoThrow } from '../../util/exec'
import type {
  PluginScope,
  GithubSource,
  DirectorySource,
  PluginUrlSource,
  KnownMarketplaces,
  InstalledPluginEntry,
  InstalledPlugins,
  MarketplacePluginDef,
  MarketplaceJson,
  PluginJson,
  PluginSettings,
  PluginComponents,
  MarketplaceInfoResult,
  PluginInfoResult,
  MarketplacePluginsInfo
} from '../../types/plugin'


// ===================== PluginsManager 类 =====================

class PluginsManager {
  private semaRootDir: string           // ~/.sema
  private pluginsBaseDir: string        // ~/.sema/plugins
  private marketplacesDir: string       // ~/.sema/plugins/marketplaces
  private cacheDir: string              // ~/.sema/plugins/cache
  private knownMarketplacesFile: string // ~/.sema/plugins/known_marketplaces.json
  private installedPluginsFile: string  // ~/.sema/plugins/installed_plugins.json

  private claudeRootDir: string         // ~/.claude
  private claudePluginsBaseDir: string  // ~/.claude/plugins

  private marketplacePluginsInfoCache: MarketplacePluginsInfo | null = null
  private loadingPromise: Promise<MarketplacePluginsInfo> | null = null

  constructor() {
    this.semaRootDir = getSemaRootDir()
    this.pluginsBaseDir = path.join(this.semaRootDir, 'plugins')
    this.marketplacesDir = path.join(this.pluginsBaseDir, 'marketplaces')
    this.cacheDir = path.join(this.pluginsBaseDir, 'cache')
    this.knownMarketplacesFile = path.join(this.pluginsBaseDir, 'known_marketplaces.json')
    this.installedPluginsFile = path.join(this.pluginsBaseDir, 'installed_plugins.json')

    this.claudeRootDir = getClaudeRootDir()
    this.claudePluginsBaseDir = path.join(this.claudeRootDir, 'plugins')

    // 后台静默加载市场插件信息
    this.loadingPromise = this.refreshMarketplacePluginsInfo()
      .catch(err => {
        logError(`后台加载市场插件信息失败: ${err}`)
        return { marketplaces: [], plugins: [] } as MarketplacePluginsInfo
      })
      .finally(() => { this.loadingPromise = null })
  }

  // ===================== 私有工具方法 =====================

  private invalidateCache(): void {
    this.marketplacePluginsInfoCache = null
  }

  private async readKnownMarketplaces(): Promise<KnownMarketplaces> {
    try {
      if (!fs.existsSync(this.knownMarketplacesFile)) return {}
      const content = await fsPromises.readFile(this.knownMarketplacesFile, 'utf8')
      return JSON.parse(content) as KnownMarketplaces
    } catch (error) {
      logError(`读取 known_marketplaces.json 失败: ${error}`)
      return {}
    }
  }

  private async writeKnownMarketplaces(data: KnownMarketplaces): Promise<void> {
    await fsPromises.mkdir(this.pluginsBaseDir, { recursive: true })
    await fsPromises.writeFile(this.knownMarketplacesFile, JSON.stringify(data, null, 2), 'utf8')
  }

  private async readInstalledPlugins(): Promise<InstalledPlugins> {
    try {
      if (!fs.existsSync(this.installedPluginsFile)) return { plugins: {} }
      const content = await fsPromises.readFile(this.installedPluginsFile, 'utf8')
      return JSON.parse(content) as InstalledPlugins
    } catch (error) {
      logError(`读取 installed_plugins.json 失败: ${error}`)
      return { plugins: {} }
    }
  }

  private async writeInstalledPlugins(data: InstalledPlugins): Promise<void> {
    await fsPromises.mkdir(this.pluginsBaseDir, { recursive: true })
    await fsPromises.writeFile(this.installedPluginsFile, JSON.stringify(data, null, 2), 'utf8')
  }

  private getSettingsFilePath(scope: PluginScope, projectPath?: string): string {
    const cwd = projectPath || getOriginalCwd()
    switch (scope) {
      case 'local':   return path.join(cwd, '.sema', 'settings.local.json')
      case 'project': return path.join(cwd, '.sema', 'settings.json')
      case 'user':    return path.join(this.semaRootDir, 'settings.json')
    }
  }

  private async readSettings(filePath: string): Promise<PluginSettings> {
    try {
      if (!fs.existsSync(filePath)) return {}
      const content = await fsPromises.readFile(filePath, 'utf8')
      return JSON.parse(content) as PluginSettings
    } catch (error) {
      logError(`读取 settings 文件失败 [${filePath}]: ${error}`)
      return {}
    }
  }

  private async writeSettings(filePath: string, data: PluginSettings): Promise<void> {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true })
    await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')
  }

  private async readMarketplaceJson(installLocation: string): Promise<MarketplaceJson | null> {
    try {
      const jsonPath = path.join(installLocation, '.claude-plugin', 'marketplace.json')
      if (!fs.existsSync(jsonPath)) {
        logWarn(`marketplace.json 不存在: ${jsonPath}`)
        return null
      }
      const content = await fsPromises.readFile(jsonPath, 'utf8')
      return JSON.parse(content) as MarketplaceJson
    } catch (error) {
      logError(`读取 marketplace.json 失败 [${installLocation}]: ${error}`)
      return null
    }
  }

  /**
   * 读取插件目录下的 commands、agents、skills 列表
   */
  private async readPluginComponents(pluginSourcePath: string): Promise<PluginComponents> {
    const components: PluginComponents = { commands: [], agents: [], skills: [], mcp: [] }
    if (!fs.existsSync(pluginSourcePath)) return components
    try {
      const commandsDir = path.join(pluginSourcePath, 'commands')
      if (fs.existsSync(commandsDir)) {
        const files = await fsPromises.readdir(commandsDir)
        components.commands = files.filter(f => f.endsWith('.md')).map(f => ({
          name: path.basename(f, '.md'),
          filePath: path.join(commandsDir, f)
        }))
      }

      const agentsDir = path.join(pluginSourcePath, 'agents')
      if (fs.existsSync(agentsDir)) {
        const files = await fsPromises.readdir(agentsDir)
        components.agents = files.filter(f => f.endsWith('.md')).map(f => ({
          name: path.basename(f, '.md'),
          filePath: path.join(agentsDir, f)
        }))
      }

      const skillsDir = path.join(pluginSourcePath, 'skills')
      if (fs.existsSync(skillsDir)) {
        const entries = await fsPromises.readdir(skillsDir, { withFileTypes: true })
        components.skills = entries
          .filter(e => e.isDirectory() && fs.existsSync(path.join(skillsDir, e.name, 'SKILL.md')))
          .map(e => ({ name: e.name, filePath: path.join(skillsDir, e.name, 'SKILL.md') }))
      }

      const mcpFile = path.join(pluginSourcePath, '.mcp.json')
      if (fs.existsSync(mcpFile)) {
        components.mcp = [{ name: '.mcp.json', filePath: mcpFile }]
      }
    } catch (error) {
      logError(`读取插件组件失败 [${pluginSourcePath}]: ${error}`)
    }
    return components
  }

  /**
   * 加载所有 scope 的 enabledPlugins
   */
  private async loadAllEnabledPlugins(): Promise<Record<PluginScope, Record<string, boolean>>> {
    const cwd = getOriginalCwd()
    const [localSettings, projectSettings, userSettings] = await Promise.all([
      this.readSettings(this.getSettingsFilePath('local', cwd)),
      this.readSettings(this.getSettingsFilePath('project', cwd)),
      this.readSettings(this.getSettingsFilePath('user'))
    ])
    return {
      local: localSettings.enabledPlugins || {},
      project: projectSettings.enabledPlugins || {},
      user: userSettings.enabledPlugins || {}
    }
  }

  // ===================== Claude 只读辅助方法 =====================

  private async readClaudeKnownMarketplaces(): Promise<KnownMarketplaces> {
    try {
      const file = path.join(this.claudePluginsBaseDir, 'known_marketplaces.json')
      if (!fs.existsSync(file)) return {}
      const content = await fsPromises.readFile(file, 'utf8')
      return JSON.parse(content) as KnownMarketplaces
    } catch (error) {
      logError(`读取 Claude known_marketplaces.json 失败: ${error}`)
      return {}
    }
  }

  private async readClaudeInstalledPlugins(): Promise<InstalledPlugins> {
    try {
      const file = path.join(this.claudePluginsBaseDir, 'installed_plugins.json')
      if (!fs.existsSync(file)) return { plugins: {} }
      const content = await fsPromises.readFile(file, 'utf8')
      return JSON.parse(content) as InstalledPlugins
    } catch (error) {
      logError(`读取 Claude installed_plugins.json 失败: ${error}`)
      return { plugins: {} }
    }
  }

  private getClaudeSettingsFilePath(scope: PluginScope, projectPath?: string): string {
    const cwd = projectPath || getOriginalCwd()
    switch (scope) {
      case 'local':   return path.join(cwd, '.claude', 'settings.local.json')
      case 'project': return path.join(cwd, '.claude', 'settings.json')
      case 'user':    return path.join(this.claudeRootDir, 'settings.json')
    }
  }

  private async loadClaudeEnabledPlugins(): Promise<Record<PluginScope, Record<string, boolean>>> {
    const cwd = getOriginalCwd()
    const [localSettings, projectSettings, userSettings] = await Promise.all([
      this.readSettings(this.getClaudeSettingsFilePath('local', cwd)),
      this.readSettings(this.getClaudeSettingsFilePath('project', cwd)),
      this.readSettings(this.getClaudeSettingsFilePath('user'))
    ])
    return {
      local: localSettings.enabledPlugins || {},
      project: projectSettings.enabledPlugins || {},
      user: userSettings.enabledPlugins || {}
    }
  }

  // ===================== 工具函数 =====================

  /**
   * 通过 git clone 下载市场仓库
   */
  private async gitCloneMarketplace(repo: string, targetDir: string): Promise<void> {
    const { code, stderr } = await execFileNoThrow(
      'git', ['clone', `https://github.com/${repo}.git`, targetDir]
    )
    if (code !== 0) {
      throw new Error(`git clone 失败 [${repo}]: ${stderr}`)
    }
  }

  /**
   * 通过 git pull 更新市场仓库
   */
  private async gitPullMarketplace(targetDir: string): Promise<void> {
    const { code, stderr } = await execFileNoThrow(
      'git', ['-C', targetDir, 'pull']
    )
    if (code !== 0) {
      throw new Error(`git pull 失败 [${targetDir}]: ${stderr}`)
    }
  }

  /**
   * 获取 git 仓库当前 commit SHA
   */
  private async getGitCommitSha(repoDir: string): Promise<string> {
    const { code, stdout } = await execFileNoThrow(
      'git', ['-C', repoDir, 'rev-parse', 'HEAD']
    )
    return code === 0 ? stdout.trim() : ''
  }

  /**
   * 读取插件目录下的 .claude-plugin/plugin.json
   */
  private async readPluginJson(pluginSourcePath: string): Promise<PluginJson | null> {
    try {
      const jsonPath = path.join(pluginSourcePath, '.claude-plugin', 'plugin.json')
      if (!fs.existsSync(jsonPath)) return null
      const content = await fsPromises.readFile(jsonPath, 'utf8')
      return JSON.parse(content) as PluginJson
    } catch (error) {
      logError(`读取 plugin.json 失败 [${pluginSourcePath}]: ${error}`)
      return null
    }
  }

  /**
   * 获取插件版本，优先级：
   * 1. marketplace.json 中 pluginDef.version 字段
   * 2. 插件目录下 .claude-plugin/plugin.json 的 version 字段
   * 3. 默认 '1.0.0'
   */
  private async getPluginVersion(pluginDef: MarketplacePluginDef, pluginSourcePath: string): Promise<string> {
    if (pluginDef.version) return pluginDef.version

    const pluginJson = await this.readPluginJson(pluginSourcePath)
    if (pluginJson?.version) return pluginJson.version

    return '1.0.0'
  }

  /**
   * 递归复制目录
   */
  private async copyDir(src: string, dest: string): Promise<void> {
    // TODO: 可替换为更高效的工具函数
    await fsPromises.mkdir(dest, { recursive: true })
    const entries = await fsPromises.readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) {
        await this.copyDir(srcPath, destPath)
      } else {
        await fsPromises.copyFile(srcPath, destPath)
      }
    }
  }

  /**
   * 递归删除目录
   */
  private async removeDir(dirPath: string): Promise<void> {
    if (fs.existsSync(dirPath)) {
      await fsPromises.rm(dirPath, { recursive: true, force: true })
    }
  }

  // ===================== 核心业务逻辑 =====================

  /**
   * 增加市场（git 方式）
   * @param repo 格式：owner/repo
   */
  async addMarketplaceFromGit(repo: string): Promise<MarketplacePluginsInfo> {
    logInfo(`添加 GitHub 市场: ${repo}`)

    const tmpDir = path.join(this.marketplacesDir, `_tmp_${Date.now()}`)
    try {
      await this.gitCloneMarketplace(repo, tmpDir)

      const marketplaceJson = await this.readMarketplaceJson(tmpDir)
      if (!marketplaceJson?.name) {
        await this.removeDir(tmpDir)
        throw new Error(`无法从 ${repo} 获取市场名称，请确认 .claude-plugin/marketplace.json 存在`)
      }

      const marketplaceName = marketplaceJson.name
      const installLocation = path.join(this.marketplacesDir, marketplaceName)

      await this.removeDir(installLocation)
      await fsPromises.rename(tmpDir, installLocation)

      const known = await this.readKnownMarketplaces()
      known[marketplaceName] = {
        source: { source: 'github', repo },
        installLocation,
        lastUpdated: new Date().toISOString()
      }
      await this.writeKnownMarketplaces(known)

      logInfo(`市场 [${marketplaceName}] 添加成功: ${installLocation}`)
    } catch (error) {
      await this.removeDir(tmpDir).catch(() => {})
      throw error
    }

    return this.refreshMarketplacePluginsInfo()
  }

  /**
   * 增加市场（本地目录方式）
   * @param dirPath 本地目录路径
   */
  async addMarketplaceFromDirectory(dirPath: string): Promise<MarketplacePluginsInfo> {
    logInfo(`添加本地目录市场: ${dirPath}`)

    if (!fs.existsSync(dirPath)) {
      throw new Error(`目录不存在: ${dirPath}`)
    }

    const marketplaceJson = await this.readMarketplaceJson(dirPath)
    if (!marketplaceJson?.name) {
      throw new Error(`无法获取市场名称，请确认 .claude-plugin/marketplace.json 存在于 ${dirPath}`)
    }

    const marketplaceName = marketplaceJson.name
    const known = await this.readKnownMarketplaces()
    known[marketplaceName] = {
      source: { source: 'directory', path: dirPath },
      installLocation: dirPath,
      lastUpdated: new Date().toISOString()
    }
    await this.writeKnownMarketplaces(known)

    logInfo(`市场 [${marketplaceName}] 添加成功 (directory): ${dirPath}`)

    return this.refreshMarketplacePluginsInfo()
  }

  /**
   * 更新市场（仅 github 来源）
   */
  async updateMarketplace(marketplaceName: string): Promise<MarketplacePluginsInfo> {
    logInfo(`更新市场: ${marketplaceName}`)

    const known = await this.readKnownMarketplaces()
    const marketplace = known[marketplaceName]
    if (!marketplace) throw new Error(`市场不存在: ${marketplaceName}`)
    if (marketplace.source.source !== 'github') {
      throw new Error(`市场 [${marketplaceName}] 不是 github 来源，无法更新`)
    }

    await this.gitPullMarketplace(marketplace.installLocation)

    marketplace.lastUpdated = new Date().toISOString()
    await this.writeKnownMarketplaces(known)

    logInfo(`市场 [${marketplaceName}] 更新成功`)

    return this.refreshMarketplacePluginsInfo()
  }

  /**
   * 移除市场
   * 同时清理 known_marketplaces.json、installed_plugins.json 相关记录, git 来源的市场目录也会被删除
   */
  async removeMarketplace(marketplaceName: string): Promise<MarketplacePluginsInfo> {
    logInfo(`移除市场: ${marketplaceName}`)

    const known = await this.readKnownMarketplaces()
    const marketplace = known[marketplaceName]
    if (!marketplace) {
      logWarn(`市场不存在，跳过移除: ${marketplaceName}`)
      return this.getMarketplacePluginsInfo()
    }

    // 1. 删除 git 克隆的目录（directory 来源不删除原始目录）
    if (marketplace.source.source === 'github') {
      await this.removeDir(marketplace.installLocation)
      logInfo(`已删除市场目录: ${marketplace.installLocation}`)
    }

    // 2. 从 known_marketplaces.json 移除
    delete known[marketplaceName]
    await this.writeKnownMarketplaces(known)

    // 3. 从 installed_plugins.json 中移除该市场的所有插件记录
    const installed = await this.readInstalledPlugins()
    for (const key of Object.keys(installed.plugins)) {
      if (key.endsWith(`@${marketplaceName}`)) {
        delete installed.plugins[key]
      }
    }
    await this.writeInstalledPlugins(installed)

    logInfo(`市场 [${marketplaceName}] 已移除`)

    return this.refreshMarketplacePluginsInfo()
  }

  /**
   * 安装插件
   * 备份到 ~/.sema/plugins/cache/市场/插件/版本
   * 在对应 scope 的 settings 中设置 enabledPlugins
   */
  async installPlugin(
    pluginName: string,
    marketplaceName: string,
    scope: PluginScope,
    projectPath?: string
  ): Promise<MarketplacePluginsInfo> {
    logInfo(`安装插件: ${pluginName}@${marketplaceName} (scope: ${scope})`)

    const known = await this.readKnownMarketplaces()
    const marketplace = known[marketplaceName]
    if (!marketplace) throw new Error(`市场不存在: ${marketplaceName}`)

    const marketplaceJson = await this.readMarketplaceJson(marketplace.installLocation)
    if (!marketplaceJson) throw new Error(`无法读取市场信息: ${marketplaceName}`)

    const pluginDef = marketplaceJson.plugins.find(p => p.name === pluginName)
    if (!pluginDef) throw new Error(`插件 [${pluginName}] 不存在于市场 [${marketplaceName}]`)

    // 解析插件源路径，url 来源需要先 git clone
    let pluginSourcePath: string
    let tmpPluginDir: string | null = null

    if (typeof pluginDef.source === 'object' && pluginDef.source.source === 'url') {
      const urlSource = pluginDef.source as PluginUrlSource
      tmpPluginDir = path.join(this.cacheDir, `_tmp_plugin_${Date.now()}`)
      logInfo(`克隆插件源: ${urlSource.url} -> ${tmpPluginDir}`)
      const { code, stderr } = await execFileNoThrow('git', ['clone', urlSource.url, tmpPluginDir])
      if (code !== 0) throw new Error(`git clone 插件失败 [${urlSource.url}]: ${stderr}`)
      pluginSourcePath = tmpPluginDir
    } else {
      pluginSourcePath = path.resolve(marketplace.installLocation, pluginDef.source as string)
    }

    try {
      const version = await this.getPluginVersion(pluginDef, pluginSourcePath)

      // 备份到 cache
      const cachePluginDir = path.join(this.cacheDir, marketplaceName, pluginName, version)
      await this.copyDir(pluginSourcePath, cachePluginDir)

      // 获取 git commit sha
      let gitCommitSha = ''
      if (marketplace.source.source === 'github') {
        gitCommitSha = await this.getGitCommitSha(marketplace.installLocation)
      }

      // 更新 installed_plugins.json
      const installed = await this.readInstalledPlugins()
      const pluginKey = `${pluginName}@${marketplaceName}`
      if (!installed.plugins[pluginKey]) installed.plugins[pluginKey] = []

      const cwd = projectPath || getOriginalCwd()
      const now = new Date().toISOString()

      // 查找同 scope 同 projectPath 的已有记录
      const existingIndex = installed.plugins[pluginKey].findIndex(entry => {
        if (entry.scope !== scope) return false
        if (scope === 'user') return true
        return entry.projectPath === cwd
      })

      const newEntry: InstalledPluginEntry = {
        scope,
        installPath: cachePluginDir,
        version,
        installedAt: existingIndex >= 0
          ? installed.plugins[pluginKey][existingIndex].installedAt
          : now,
        lastUpdated: now,
        ...(gitCommitSha && { gitCommitSha }),
        ...(scope !== 'user' && { projectPath: cwd })
      }

      if (existingIndex >= 0) {
        installed.plugins[pluginKey][existingIndex] = newEntry
      } else {
        installed.plugins[pluginKey].push(newEntry)
      }
      await this.writeInstalledPlugins(installed)

      // 在 settings 中启用该插件
      const settingsPath = this.getSettingsFilePath(scope, projectPath)
      const settings = await this.readSettings(settingsPath)
      if (!settings.enabledPlugins) settings.enabledPlugins = {}
      settings.enabledPlugins[pluginKey] = true
      await this.writeSettings(settingsPath, settings)

      logInfo(`插件 [${pluginKey}] 安装成功 (scope: ${scope})`)

      return this.refreshMarketplacePluginsInfo()
    } finally {
      // 清理 url 来源的临时克隆目录
      if (tmpPluginDir) {
        await this.removeDir(tmpPluginDir).catch(() => {})
      }
    }
  }

  /**
   * 卸载插件
   * 从 installed_plugins.json 删除记录，从 settings 移除 enabledPlugins，cache 中已下载的插件源文件不删除
   */
  async uninstallPlugin(
    pluginName: string,
    marketplaceName: string,
    scope: PluginScope,
    projectPath?: string
  ): Promise<MarketplacePluginsInfo> {
    logInfo(`卸载插件: ${pluginName}@${marketplaceName} (scope: ${scope})`)

    const pluginKey = `${pluginName}@${marketplaceName}`
    const cwd = projectPath || getOriginalCwd()

    // 1. 从 installed_plugins.json 移除对应记录
    const installed = await this.readInstalledPlugins()
    if (installed.plugins[pluginKey]) {
      installed.plugins[pluginKey] = installed.plugins[pluginKey].filter(entry => {
        if (entry.scope !== scope) return true
        if (scope === 'user') return false
        return entry.projectPath !== cwd
      })
      if (installed.plugins[pluginKey].length === 0) {
        delete installed.plugins[pluginKey]
      }
    }
    await this.writeInstalledPlugins(installed)

    // 2. 从 settings 中移除
    const settingsPath = this.getSettingsFilePath(scope, projectPath)
    const settings = await this.readSettings(settingsPath)
    if (settings.enabledPlugins) {
      delete settings.enabledPlugins[pluginKey]
    }
    await this.writeSettings(settingsPath, settings)

    logInfo(`插件 [${pluginKey}] 已卸载 (scope: ${scope})`)

    return this.refreshMarketplacePluginsInfo()
  }

  /**
   * 开启插件
   */
  async enablePlugin(
    pluginName: string,
    marketplaceName: string,
    scope: PluginScope,
    projectPath?: string
  ): Promise<MarketplacePluginsInfo> {
    return this.setPluginEnabled(pluginName, marketplaceName, scope, true, projectPath)
  }

  /**
   * 禁用插件
   */
  async disablePlugin(
    pluginName: string,
    marketplaceName: string,
    scope: PluginScope,
    projectPath?: string
  ): Promise<MarketplacePluginsInfo> {
    return this.setPluginEnabled(pluginName, marketplaceName, scope, false, projectPath)
  }

  private async setPluginEnabled(
    pluginName: string,
    marketplaceName: string,
    scope: PluginScope,
    enabled: boolean,
    projectPath?: string
  ): Promise<MarketplacePluginsInfo> {
    const pluginKey = `${pluginName}@${marketplaceName}`
    logInfo(`${enabled ? '开启' : '禁用'}插件: ${pluginKey} (scope: ${scope})`)

    const settingsPath = this.getSettingsFilePath(scope, projectPath)
    const settings = await this.readSettings(settingsPath)
    if (!settings.enabledPlugins) settings.enabledPlugins = {}
    settings.enabledPlugins[pluginKey] = enabled
    await this.writeSettings(settingsPath, settings)

    logInfo(`插件 [${pluginKey}] 已${enabled ? '开启' : '禁用'}`)

    return this.refreshMarketplacePluginsInfo()
  }

  /**
   * 更新插件（重新安装最新版本）
   */
  async updatePlugin(
    pluginName: string,
    marketplaceName: string,
    scope: PluginScope,
    projectPath?: string
  ): Promise<MarketplacePluginsInfo> {
    logInfo(`更新插件: ${pluginName}@${marketplaceName} (scope: ${scope})`)
    return this.installPlugin(pluginName, marketplaceName, scope, projectPath)
  }

  /**
   * 根据 known/installed/enabled 数据构建市场插件结果
   */
  private async buildMarketplaceResult(
    known: KnownMarketplaces,
    installed: InstalledPlugins,
    enabledPluginsMap: Record<PluginScope, Record<string, boolean>>,
    from: 'sema' | 'claude' = 'sema'
  ): Promise<{ marketplaces: MarketplaceInfoResult[], plugins: PluginInfoResult[] }> {
    const marketplacesResult: MarketplaceInfoResult[] = []
    const pluginsResult: PluginInfoResult[] = []

    for (const [marketplaceName, marketplaceInfo] of Object.entries(known)) {
      const marketplaceJson = await this.readMarketplaceJson(marketplaceInfo.installLocation)

      const available: MarketplaceInfoResult['available'] = []
      const installedInMarket: string[] = []

      if (marketplaceJson) {
        for (const pluginDef of marketplaceJson.plugins) {
          available.push({
            name: pluginDef.name,
            description: pluginDef.description || '',
            author: pluginDef.author?.name || ''
          })

          const pluginKey = `${pluginDef.name}@${marketplaceName}`
          const installEntries = installed.plugins[pluginKey]

          if (installEntries?.length) {
            installedInMarket.push(pluginDef.name)

            for (const entry of installEntries) {
              const components = await this.readPluginComponents(entry.installPath)
              const status = enabledPluginsMap[entry.scope]?.[pluginKey] ?? false

              pluginsResult.push({
                name: pluginDef.name,
                marketplace: marketplaceName,
                scope: entry.scope,
                status,
                version: entry.version || '',
                description: pluginDef.description || '',
                author: pluginDef.author?.name || '',
                components,
                from
              })
            }
          }
        }
      }

      const sourceObj: MarketplaceInfoResult['source'] = {
        source: marketplaceInfo.source.source
      }
      if (marketplaceInfo.source.source === 'github') {
        sourceObj.repo = (marketplaceInfo.source as GithubSource).repo
      } else {
        sourceObj.path = (marketplaceInfo.source as DirectorySource).path
      }

      marketplacesResult.push({
        name: marketplaceName,
        source: sourceObj,
        lastUpdated: marketplaceInfo.lastUpdated?.split('T')[0] || '',
        available,
        installed: installedInMarket,
        from
      })
    }

    return { marketplaces: marketplacesResult, plugins: pluginsResult }
  }

  /**
   * 刷新市场插件信息
   * 重新读取所有配置文件，更新缓存（包含 Sema 和 Claude 两套来源）
   */
  async refreshMarketplacePluginsInfo(): Promise<MarketplacePluginsInfo> {
    logDebug('刷新市场插件信息...')
    this.invalidateCache()

    const enableClaudeCodeCompat = getConfManager().getCoreConfig()?.enableClaudeCodeCompat !== false

    const [
      known, installed, enabledPluginsMap,
      claudeKnown, claudeInstalled, claudeEnabledPluginsMap
    ] = await Promise.all([
      this.readKnownMarketplaces(),
      this.readInstalledPlugins(),
      this.loadAllEnabledPlugins(),
      enableClaudeCodeCompat ? this.readClaudeKnownMarketplaces() : Promise.resolve({} as KnownMarketplaces),
      enableClaudeCodeCompat ? this.readClaudeInstalledPlugins() : Promise.resolve({ plugins: {} } as InstalledPlugins),
      enableClaudeCodeCompat ? this.loadClaudeEnabledPlugins() : Promise.resolve({ local: {}, project: {}, user: {} } as Record<PluginScope, Record<string, boolean>>)
    ])

    const [semaResult, claudeResult] = await Promise.all([
      this.buildMarketplaceResult(known, installed, enabledPluginsMap, 'sema'),
      enableClaudeCodeCompat
        ? this.buildMarketplaceResult(claudeKnown, claudeInstalled, claudeEnabledPluginsMap, 'claude')
        : Promise.resolve({ marketplaces: [], plugins: [] })
    ])

    const info: MarketplacePluginsInfo = {
      marketplaces: [...semaResult.marketplaces, ...claudeResult.marketplaces],
      plugins: [...semaResult.plugins, ...claudeResult.plugins]
    }

    this.marketplacePluginsInfoCache = info
    logInfo(`市场插件信息刷新完成: ${info.marketplaces.length} 个市场, ${info.plugins.length} 个插件`)

    // 插件变更后后台触发 agents/skills/commands 刷新，不阻塞当前流程（动态 import 避免循环依赖）
    setImmediate(() => {
      import('../agents/agentsManager').then(({ getAgentsManager }) => {
        getAgentsManager().refreshAgentsInfo().catch((err: unknown) => logError(`插件变更后刷新 Agents 失败: ${err}`))
      }).catch(() => {})
      import('../skills/skillsManager').then(({ getSkillsManager }) => {
        getSkillsManager().refreshSkillsInfo().catch((err: unknown) => logError(`插件变更后刷新 Skills 失败: ${err}`))
      }).catch(() => {})
      import('../commands/commandsManager').then(({ getCommandsManager }) => {
        getCommandsManager().refreshCommandsInfo().catch((err: unknown) => logError(`插件变更后刷新 Commands 失败: ${err}`))
      }).catch(() => {})
      import('../mcp/MCPManager').then(({ getMCPManager }) => {
        getMCPManager().refreshMCPServerConfigs().catch((err: unknown) => logError(`插件变更后刷新 MCP 失败: ${err}`))
      }).catch(() => {})
    })

    return info
  }

  /**
   * 获取市场插件信息（有缓存则直接返回，否则等待后台加载或重新加载）
   */
  async getMarketplacePluginsInfo(): Promise<MarketplacePluginsInfo> {
    if (this.marketplacePluginsInfoCache) {
      return this.marketplacePluginsInfoCache
    }
    if (this.loadingPromise) {
      return this.loadingPromise
    }
    return this.refreshMarketplacePluginsInfo()
  }

  dispose(): void {
    this.invalidateCache()
  }
}

// ===================== 全局单例 =====================

let pluginsManagerInstance: PluginsManager | null = null

export function getPluginsManager(): PluginsManager {
  if (!pluginsManagerInstance) {
    pluginsManagerInstance = new PluginsManager()
  }
  return pluginsManagerInstance
}

export { PluginsManager }

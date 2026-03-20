/**
 * Agents 管理器
 *
 * 管理自定义 Agent 的全局注册和查找
 * 实现优先级：内置 < 用户级 < 项目级 (后加载的覆盖先加载的)
 * 兼容 Claude Code 和 Sema 两套路径（Claude 只读）
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { AgentConfig, AgentScope } from '../../types/agent'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getSemaRootDir, getClaudeRootDir } from '../../util/savePath'
import { getOriginalCwd } from '../../util/cwd'
import { parseFile } from '../../util/formatter'
import { defaultBuiltInAgentsConfs } from './defaultBuiltInAgentsConfs'
import { getPluginsManager } from '../plugins/pluginsManager'
import { getConfManager } from '../../manager/ConfManager'

/**
 * Agents 管理器类 - 单例模式
 */
class AgentsManager {
  private semaRootDir: string           // ~/.sema
  private semaUserAgentsDir: string     // ~/.sema/agents
  private semaProjectAgentsDir: string  // <project>/.sema/agents

  private claudeRootDir: string          // ~/.claude
  private claudeUserAgentsDir: string    // ~/.claude/agents
  private claudeProjectAgentsDir: string // <project>/.claude/agents

  private agentConfigs: Map<string, AgentConfig> = new Map()
  // Agents 信息缓存
  private agentInfoCache: AgentConfig[] | null = null
  // 后台加载 Promise
  private loadingPromise: Promise<AgentConfig[]> | null = null

  constructor() {
    // 初始化所有路径
    this.semaRootDir = getSemaRootDir()
    this.semaUserAgentsDir = path.join(this.semaRootDir, 'agents')

    this.claudeRootDir = getClaudeRootDir()
    this.claudeUserAgentsDir = path.join(this.claudeRootDir, 'agents')

    const cwd = getOriginalCwd()
    this.semaProjectAgentsDir = path.join(cwd, '.sema', 'agents')
    this.claudeProjectAgentsDir = path.join(cwd, '.claude', 'agents')

    // 后台静默加载 agents 信息
    this.loadingPromise = this.refreshAgentsInfo()
      .catch(err => {
        logError(`后台加载 Agents 信息失败: ${err}`)
        return [] as AgentConfig[]
      })
      .finally(() => { this.loadingPromise = null })
  }

  /**
   * 清空缓存
   */
  private invalidateCache(): void {
    this.agentInfoCache = null
  }

  /**
   * 加载 Agents 配置（内部方法）
   * 按优先级加载：用户级(Claude) -> 项目级(Claude) -> 内置 -> 插件 -> 用户级(Sema) -> 项目级(Sema)
   * 后加载的覆盖先加载的，优先级从高到低：项目级(Sema) > 用户级(Sema) > 插件 > 内置 > 项目级(Claude) > 用户级(Claude)
   */
  private async loadAgents(): Promise<void> {
    // 清空现有配置
    this.agentConfigs.clear()

    const enableClaudeCodeCompat = getConfManager().getCoreConfig()?.enableClaudeCodeCompat !== false

    // 按优先级顺序加载（后加载的覆盖先加载的）
    // 1. 用户级(Claude) - 最低优先级
    if (enableClaudeCodeCompat) {
      await this.loadAgentsFromDir(this.claudeUserAgentsDir, 'user', 'claude')
    }

    // 2. 项目级(Claude)
    if (enableClaudeCodeCompat) {
      await this.loadAgentsFromDir(this.claudeProjectAgentsDir, 'project', 'claude')
    }

    // 3. 内置 agents
    this.loadBuiltInAgents()

    // 4. 插件 agents
    await this.loadAgentsFromPlugins()

    // 5. 用户级(Sema)
    await this.loadAgentsFromDir(this.semaUserAgentsDir, 'user', 'sema')

    // 6. 项目级(Sema) - 最高优先级
    await this.loadAgentsFromDir(this.semaProjectAgentsDir, 'project', 'sema')

    const agentNames = Array.from(this.agentConfigs.keys()).join(', ')
    logInfo(`加载 Agents 配置: ${agentNames}`)
  }

  /**
   * 加载内置 agents
   */
  private loadBuiltInAgents(): void {
    for (const config of defaultBuiltInAgentsConfs) {
      // 为内置配置补充默认字段，确保类型完整
      const fullConfig: AgentConfig = {
        ...config,
        locate: "builtin",
        from: "sema"
      }
      this.agentConfigs.set(config.name, fullConfig)
    }
    logDebug(`加载内置 Agents: ${defaultBuiltInAgentsConfs.length} 个`)
  }

  /**
   * 从已安装且启用的插件中加载 agents
   * agent 名格式：插件名:agent名，scope 为 'plugin'
   */
  private async loadAgentsFromPlugins(): Promise<void> {
    try {
      const pluginsInfo = await getPluginsManager().getMarketplacePluginsInfo()
      const enabledPlugins = pluginsInfo.plugins.filter(p => p.status)

      let loadedCount = 0
      for (const plugin of enabledPlugins) {
        for (const agentEntry of plugin.components.agents) {
          const agentConfig = await this.parseAgentFile(agentEntry.filePath)
          if (agentConfig) {
            const pluginAgentName = `${plugin.name}:${agentConfig.name}`
            if (this.agentConfigs.has(pluginAgentName)) {
              logDebug(`Agent [${pluginAgentName}] 被插件配置覆盖`)
            }
            this.agentConfigs.set(pluginAgentName, {
              ...agentConfig,
              name: pluginAgentName,
              locate: 'plugin',
              from: plugin.from
            })
            loadedCount++
          }
        }
      }

      if (loadedCount > 0) {
        logDebug(`加载插件 Agents: ${loadedCount} 个`)
      }
    } catch (error) {
      logError(`加载插件 Agents 失败: ${error}`)
    }
  }

  /**
   * 从指定目录加载 agent 配置
   * Claude 来源为只读
   */
  private async loadAgentsFromDir(dirPath: string, scope: 'user' | 'project', from: 'sema' | 'claude'): Promise<void> {
    try {
      if (!fs.existsSync(dirPath)) {
        logDebug(`Agents 目录不存在: ${dirPath}`)
        return
      }

      const files = await fsPromises.readdir(dirPath)

      // 批量并行解析所有 .md 文件
      const parsePromises = files
        .filter(file => file.endsWith('.md'))
        .map(file => this.parseAgentFile(path.join(dirPath, file)))

      const agentConfigs = await Promise.all(parsePromises)

      // 统计加载数量
      let loadedCount = 0
      const locateValue = scope === 'user' ? 'user' : 'project'
      for (const agentConfig of agentConfigs) {
        if (agentConfig) {
          // 如果已存在同名 agent，记录覆盖日志
          if (this.agentConfigs.has(agentConfig.name)) {
            logDebug(`Agent [${agentConfig.name}] 被 ${from} ${scope} 级配置覆盖`)
          }
          this.agentConfigs.set(agentConfig.name, { ...agentConfig, locate: locateValue, from })
          loadedCount++
        }
      }

      if (loadedCount > 0) {
        logDebug(`加载 ${from} ${scope} 级 Agents: ${loadedCount} 个`)
      }
    } catch (error) {
      logError(`加载 ${from} ${scope} 级 Agents 失败 [${dirPath}]: ${error}`)
    }
  }

  /**
   * 解析 Agent Markdown 文件
   * 使用 parseClaudeFile 统一解析 frontmatter
   */
  private async parseAgentFile(filePath: string): Promise<AgentConfig | null> {
    try {
      // 解析文件
      const { metadata, prompt } = parseFile(filePath)

      // 验证必需字段：name、description、prompt 必须是非空字符串
      const name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
      const description = typeof metadata.description === 'string' ? metadata.description.trim() : ''
      const promptStr = prompt.trim()

      if (!name || !description || !promptStr) {
        logWarn(`Agent 文件格式错误 [${filePath}]: name/description/prompt 必须为非空字符串`)
        return null
      }

      // 解析 tools 字段，默认 '*'
      let tools: string[] | '*' = '*'
      if (metadata.tools) {
        const toolsValue = metadata.tools
        if (toolsValue === '*' || toolsValue === '"*"') {
          tools = '*'
        } else if (typeof toolsValue === 'string') {
          // 支持逗号分隔的字符串格式
          const parsed = toolsValue.split(',').map((t: string) => t.trim()).filter((t: string) => t)
          if (parsed.length > 0) {
            tools = parsed
          }
        } else if (Array.isArray(toolsValue) && toolsValue.length > 0) {
          tools = toolsValue
        }
      }

      // model 只取字符串类型，非字符串忽略，回退默认值 'haiku'
      const model = typeof metadata.model === 'string' && metadata.model.trim()
        ? metadata.model.trim()
        : 'haiku'

      // 构造完整的 AgentConfig
      const agentConfig: AgentConfig = {
        name,
        description,
        tools,
        model,
        prompt: promptStr,
        filePath
      }

      return agentConfig
    } catch (error) {
      logError(`解析 Agent 文件失败 [${filePath}]: ${error}`)
      return null
    }
  }

  /**
   * 获取所有 Agent 配置
   */
  private getAgentsConfs(): AgentConfig[] {
    return Array.from(this.agentConfigs.values())
  }

  /**
   * 获取所有 Agent 信息（有缓存则直接返回，否则等待后台加载或重新加载）
   */
  async getAgentsInfo(): Promise<AgentConfig[]> {
    if (this.agentInfoCache) {
      return this.agentInfoCache
    }
    if (this.loadingPromise) {
      return this.loadingPromise
    }
    return this.refreshAgentsInfo()
  }

  /**
   * 刷新 Agents 信息
   * 重新加载所有配置，更新缓存
   */
  async refreshAgentsInfo(): Promise<AgentConfig[]> {
    logDebug('刷新 Agents 信息...')
    this.invalidateCache()

    await this.loadAgents()

    const agentInfos = this.getAgentsConfs().map(config => ({
      name: config.name,
      description: config.description,
      tools: config.tools,
      model: config.model,
      prompt: config.prompt,
      locate: config.locate as AgentScope,
      from: config.from,
      filePath: config.filePath
    }))

    this.agentInfoCache = agentInfos
    logInfo(`Agents 信息刷新完成: ${agentInfos.length} 个 Agent`)
    return agentInfos
  }

  /**
   * 根据名称获取 Agent 配置
   */
  getAgentConfig(name: string): AgentConfig | undefined {
    return this.agentConfigs.get(name)
  }

  /**
   * 获取所有子代理的类型描述
   * 格式: "- AgentName: description"
   */
  getAgentTypesDescription(): string {
    const agentsConfs = this.getAgentsConfs()
    if (agentsConfs.length === 0) {
      return ''
    }
    return agentsConfs
      .map(agent => `- ${agent.name}: ${agent.description}`)
      .join('\n')
  }

  /**
   * 保存 Agent 配置到文件
   */
  private async saveAgentToFile(agentConf: AgentConfig): Promise<boolean> {
    try {
      const targetDir = agentConf.locate === 'user' ? this.semaUserAgentsDir : this.semaProjectAgentsDir

      if (!fs.existsSync(targetDir)) {
        await fsPromises.mkdir(targetDir, { recursive: true })
      }

      const filePath = path.join(targetDir, `${agentConf.name}.md`)
      const content = this.generateAgentFileContent(agentConf)
      await fsPromises.writeFile(filePath, content, 'utf8')

      logInfo(`Agent 配置已保存到文件: ${filePath}`)
      return true
    } catch (error) {
      logError(`保存 Agent 配置到文件失败 [${agentConf.name}]: ${error}`)
      return false
    }
  }

  /**
   * 生成 Agent 文件内容（Markdown 格式）
   */
  private generateAgentFileContent(agentConf: AgentConfig): string {
    const lines = ['---']

    lines.push(`name: ${agentConf.name}`)

    // 添加 description（如果包含特殊字符，用引号包围）
    const description = agentConf.description
    if (description.includes(':') || description.includes('"') || description.includes("'")) {
      lines.push(`description: "${description.replace(/"/g, '\\"')}"`)
    } else {
      lines.push(`description: ${description}`)
    }

    // 添加 tools（如果存在）
    if (agentConf.tools) {
      if (agentConf.tools === '*') {
        lines.push('tools: "*"')
      } else if (Array.isArray(agentConf.tools)) {
        lines.push(`tools: ${agentConf.tools.join(', ')}`)
      }
    }

    if (agentConf.model) {
      lines.push(`model: ${agentConf.model}`)
    }

    lines.push('---')
    lines.push('')

    if (agentConf.prompt) {
      lines.push(agentConf.prompt)
    }

    return lines.join('\n')
  }

  /**
   * 添加 Agent 配置
   * 只能添加到 Sema 路径（Claude 为只读）
   */
  async addAgentConf(agentConf: AgentConfig): Promise<AgentConfig[]> {
    if (!agentConf.name || !agentConf.description || !agentConf.prompt) {
      logWarn(`添加 Agent 失败: 缺少必需字段 name、prompt 或 description`)
      return this.getAgentsInfo()
    }

    if (!agentConf.locate || (agentConf.locate !== 'project' && agentConf.locate !== 'user')) {
      logWarn(`添加 Agent 失败: locate 必须为 'project' 或 'user'`)
      return this.getAgentsInfo()
    }

    // 如果已存在同名 agent，记录覆盖日志
    if (this.agentConfigs.has(agentConf.name)) {
      logWarn(`Agent [${agentConf.name}] 被覆盖`)
    }

    this.agentConfigs.set(agentConf.name, { ...agentConf })
    this.invalidateCache()
    logInfo(`添加 Agent 配置: ${agentConf.name}`)

    const saved = await this.saveAgentToFile(agentConf)
    if (!saved) {
      logWarn(`Agent 配置已添加到内存，但保存到文件失败: ${agentConf.name}`)
    }

    return this.refreshAgentsInfo()
  }

  /**
   * 移除 Agent 配置
   * Claude 来源为只读，不可移除
   */
  async removeAgentConf(name: string): Promise<AgentConfig[]> {
    const agentConf = this.agentConfigs.get(name)
    if (!agentConf) {
      logWarn(`移除 Agent 失败: 未找到 [${name}]`)
      return this.getAgentsInfo()
    }

    if (agentConf.from === 'claude') {
      logWarn(`移除 Agent 失败: Claude 来源为只读 [${name}]`)
      return this.getAgentsInfo()
    }

    if (agentConf.locate === 'builtin') {
      logWarn(`移除 Agent 失败: 内置 Agent 不可移除 [${name}]`)
      return this.getAgentsInfo()
    }

    this.agentConfigs.delete(name)
    this.invalidateCache()

    // 删除 agent 文件
    const targetDir = agentConf.locate === 'user' ? this.semaUserAgentsDir : this.semaProjectAgentsDir
    const agentFilePath = agentConf.filePath ?? path.join(targetDir, `${name}.md`)
    try {
      if (fs.existsSync(agentFilePath)) {
        await fsPromises.unlink(agentFilePath)
        logInfo(`Agent 配置文件已删除: ${agentFilePath}`)

        // 如果父目录为空则一并删除
        const parentDir = path.dirname(agentFilePath)
        if (parentDir !== targetDir) {
          const siblings = await fsPromises.readdir(parentDir)
          if (siblings.length === 0) {
            await fsPromises.rm(parentDir, { recursive: true })
            logDebug(`Agent 空目录已删除: ${parentDir}`)
          }
        }
      }
    } catch (error) {
      logError(`删除 Agent 配置文件失败 [${agentFilePath}]: ${error}`)
    }

    logInfo(`移除 Agent 配置: ${name}`)
    return this.refreshAgentsInfo()
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.agentConfigs.clear()
    this.invalidateCache()
  }
}

// ===================== 全局 Agents 管理器 =====================

let agentsManagerInstance: AgentsManager | null = null

/**
 * 获取 Agents Manager 实例（单例模式）
 */
export function getAgentsManager(): AgentsManager {
  if (!agentsManagerInstance) {
    agentsManagerInstance = new AgentsManager()
  }
  return agentsManagerInstance
}

export function getAgentTypesDescription(): string {
  return getAgentsManager().getAgentTypesDescription()
}

export { AgentsManager }

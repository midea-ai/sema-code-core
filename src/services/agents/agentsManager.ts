/**
 * Agents 管理器
 *
 * 管理自定义 Agent 的全局注册和查找
 * 实现优先级：项目级 > 用户级 > 内置
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { AgentConfig, AgentInfo } from '../../types/agent'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getSemaRootDir } from '../../util/savePath'
import { getOriginalCwd } from '../../util/cwd'
import { extractFrontmatter, parseFrontmatter } from '../../util/frontmatter'
import { defaultBuiltInAgentsConfs } from './defaultBuiltInAgentsConfs'

/**
 * Agent 文件缓存项
 */
interface AgentFileCache {
  mtime: number
  config: AgentConfig
}

/**
 * Agents 管理器类 - 单例模式
 */
class AgentsManager {
  private userAgentsDir: string
  private projectAgentsDir: string
  private agentConfigs: Map<string, AgentConfig> = new Map()
  // 文件缓存：记录每个文件的修改时间和解析结果
  private fileCache: Map<string, AgentFileCache> = new Map()
  // AgentConfigs 数组缓存
  private agentConfigsArrayCache: AgentConfig[] | null = null

  constructor(userAgentsDir: string, projectAgentsDir: string) {
    this.userAgentsDir = userAgentsDir
    this.projectAgentsDir = projectAgentsDir
  }

  /**
   * 使数组缓存失效
   */
  private invalidateCache(): void {
    this.agentConfigsArrayCache = null
  }

  /**
   * 初始化 Agents 配置（异步）
   * 按优先级加载：内置 -> 用户级 -> 项目级
   */
  async init(): Promise<void> {
    // 清空现有配置（保留文件缓存）
    this.agentConfigs.clear()
    this.invalidateCache()

    // 1. 加载内置 agents（最低优先级）
    this.loadBuiltInAgents()

    // 2. 并行加载用户级和项目级 agents
    await Promise.all([
      this.loadAgentsFromDir(this.userAgentsDir, 'user'),
      this.loadAgentsFromDir(this.projectAgentsDir, 'project')
    ])

    const agentNames = Array.from(this.agentConfigs.keys()).join(', ')
    logInfo(`加载 Agents 配置: ${agentNames}`)
  }

  /**
   * 加载内置 agents
   */
  private loadBuiltInAgents(): void {
    for (const config of defaultBuiltInAgentsConfs) {
      this.agentConfigs.set(config.name, { ...config, locate: 'builtin' })
    }
    logDebug(`加载内置 Agents: ${defaultBuiltInAgentsConfs.length} 个`)
  }

  /**
   * 从指定目录加载 agent 配置（异步，支持缓存）
   */
  private async loadAgentsFromDir(dirPath: string, scope: 'user' | 'project'): Promise<void> {
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
            logWarn(`Agent [${agentConfig.name}] 被 ${scope} 级配置覆盖`)
          }
          this.agentConfigs.set(agentConfig.name, { ...agentConfig, locate: locateValue })
          loadedCount++
        }
      }

      if (loadedCount > 0) {
        logDebug(`加载 ${scope} 级 Agents: ${loadedCount} 个`)
      }
    } catch (error) {
      logError(`加载 ${scope} 级 Agents 失败 [${dirPath}]: ${error}`)
    }
  }

  /**
   * 解析 Agent Markdown 文件（异步，支持缓存）
   * 格式：
   * ---
   * name: agent-name
   * description: "agent description"
   * tools: Glob, Grep, Read
   * model: haiku
   * ---
   *
   * Agent prompt content here...
   */
  private async parseAgentFile(filePath: string): Promise<AgentConfig | null> {
    try {
      // 检查缓存
      const stats = await fsPromises.stat(filePath)
      const cached = this.fileCache.get(filePath)

      if (cached && cached.mtime === stats.mtimeMs) {
        // 缓存命中，直接返回
        return cached.config
      }

      // 缓存未命中，异步读取文件
      const content = await fsPromises.readFile(filePath, 'utf8')

      // 提取 frontmatter
      const extracted = extractFrontmatter(content)
      if (!extracted) {
        logWarn(`Agent 文件格式错误 [${filePath}]: 缺少 frontmatter`)
        return null
      }

      const [frontmatterText, prompt] = extracted

      // 解析 frontmatter
      const metadata = parseFrontmatter(frontmatterText)

      // 验证必需字段
      if (!metadata.name || !metadata.description) {
        logWarn(`Agent 文件格式错误 [${filePath}]: 缺少必需字段 name 或 description`)
        return null
      }

      // 解析 tools 字段
      let tools: string[] | '*' | undefined
      if (metadata.tools) {
        const toolsValue = metadata.tools
        if (toolsValue === '*') {
          tools = '*'
        } else if (typeof toolsValue === 'string') {
          // 支持逗号分隔的字符串格式
          tools = toolsValue.split(',').map((t: string) => t.trim()).filter((t: string) => t)
        } else if (Array.isArray(toolsValue)) {
          tools = toolsValue
        }
      }

      const agentConfig: AgentConfig = {
        name: metadata.name as string,
        description: metadata.description as string,
        tools,
        model: metadata.model as string | undefined,
        prompt
      }

      // 更新缓存
      this.fileCache.set(filePath, { mtime: stats.mtimeMs, config: agentConfig })

      return agentConfig
    } catch (error) {
      logError(`解析 Agent 文件失败 [${filePath}]: ${error}`)
      return null
    }
  }

  /**
   * 获取所有 Agent 配置（带缓存）
   */
  getAgentsConfs(): AgentConfig[] {
    if (!this.agentConfigsArrayCache) {
      this.agentConfigsArrayCache = Array.from(this.agentConfigs.values())
    }
    return this.agentConfigsArrayCache
  }

  /**
   * 获取所有 Agent 信息
   */
  getAgentsInfo(): AgentInfo[] {
    return this.getAgentsConfs().map(config => ({
      name: config.name,
      description: config.description,
      tools: config.tools,
      model: config.model,
      locate: config.locate ?? 'builtin'
    }))
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
      const targetDir = agentConf.locate === 'user' ? this.userAgentsDir : this.projectAgentsDir

      if (!fs.existsSync(targetDir)) {
        await fsPromises.mkdir(targetDir, { recursive: true })
      }

      const filePath = path.join(targetDir, `${agentConf.name}.md`)
      const content = this.generateAgentFileContent(agentConf)
      await fsPromises.writeFile(filePath, content, 'utf8')

      const stats = await fsPromises.stat(filePath)
      this.fileCache.set(filePath, { mtime: stats.mtimeMs, config: agentConf })

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
   */
  async addAgentConf(agentConf: AgentConfig): Promise<boolean> {
    if (!agentConf.name || !agentConf.description) {
      logWarn(`添加 Agent 失败: 缺少必需字段 name 或 description`)
      return false
    }

    if (!agentConf.locate || (agentConf.locate !== 'project' && agentConf.locate !== 'user')) {
      logWarn(`添加 Agent 失败: locate 必须为 'project' 或 'user'`)
      return false
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

    return true
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.agentConfigs.clear()
    this.fileCache.clear()
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
    const userAgentsDir = path.join(getSemaRootDir(), 'agents')
    const projectAgentsDir = path.join(getOriginalCwd(), '.sema', 'agents')

    agentsManagerInstance = new AgentsManager(userAgentsDir, projectAgentsDir)
  }
  return agentsManagerInstance
}

/**
 * 初始化 Agents Manager（异步）
 */
export async function initAgentsManager(): Promise<void> {
  const manager = getAgentsManager()
  await manager.init()
}

/**
 * 获取所有 Agent 配置
 */
export function getAgentsConfs(): AgentConfig[] {
  const manager = getAgentsManager()
  return manager.getAgentsConfs()
}

/**
 * 获取所有 Agent 信息
 */
export function getAgentsInfo(): AgentInfo[] {
  const manager = getAgentsManager()
  return manager.getAgentsInfo()
}

/**
 * 根据名称获取 Agent 配置
 */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const manager = getAgentsManager()
  return manager.getAgentConfig(name)
}

/**
 * 添加 Agent 配置
 */
export async function addAgentConf(agentConf: AgentConfig): Promise<boolean> {
  const manager = getAgentsManager()
  return await manager.addAgentConf(agentConf)
}

export { AgentsManager }

/**
 * 获取所有子代理的类型描述（用于 Task 工具的 prompt）
 * 格式: "- AgentName: description"
 */
export function getAgentTypesDescription(): string {
  const manager = getAgentsManager()
  return manager.getAgentTypesDescription()
}
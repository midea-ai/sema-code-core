/**
 * Commands 管理器
 *
 * 管理自定义 Command 的全局注册和查找
 * 实现优先级：用户级(Claude) < 项目级(Claude) < 用户级(Sema) < 项目级(Sema)
 * 兼容 Claude Code 和 Sema 两套路径（Claude 只读）
 *
 * 文件结构：<commands-dir>/<command-name>.md 或 <commands-dir>/<namespace>/<command-name>.md
 * 命令名规则：文件路径相对于 commands 目录，去掉 .md 后缀，路径分隔符替换为冒号
 * 例如：frontend/test.md → frontend:test
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getSemaRootDir, getClaudeRootDir } from '../../util/savePath'
import { getOriginalCwd } from '../../util/cwd'
import { parseFile } from '../../util/formatter'
import { getPluginsManager } from '../plugins/pluginsManager'
import { CommandConfig } from '../../types/command'


/**
 * Commands 管理器类 - 单例模式
 */
class CommandsManager {
  private semaUserCommandsDir: string     // ~/.sema/commands
  private semaProjectCommandsDir: string  // <project>/.sema/commands

  private claudeUserCommandsDir: string    // ~/.claude/commands
  private claudeProjectCommandsDir: string // <project>/.claude/commands

  private commandConfigs: Map<string, CommandConfig> = new Map()
  // Commands 信息缓存
  private commandInfoCache: CommandConfig[] | null = null
  // 后台加载 Promise
  private loadingPromise: Promise<CommandConfig[]> | null = null

  constructor() {
    const semaRootDir = getSemaRootDir()
    this.semaUserCommandsDir = path.join(semaRootDir, 'commands')

    const claudeRootDir = getClaudeRootDir()
    this.claudeUserCommandsDir = path.join(claudeRootDir, 'commands')

    const cwd = getOriginalCwd()
    this.semaProjectCommandsDir = path.join(cwd, '.sema', 'commands')
    this.claudeProjectCommandsDir = path.join(cwd, '.claude', 'commands')

    // 后台静默加载 commands 信息
    this.loadingPromise = this.refreshCommandsInfo()
      .catch(err => {
        logError(`后台加载 Commands 信息失败: ${err}`)
        return [] as CommandConfig[]
      })
      .finally(() => { this.loadingPromise = null })
  }

  /**
   * 清空缓存
   */
  private invalidateCache(): void {
    this.commandInfoCache = null
  }

  /**
   * 加载 Commands 配置（内部方法）
   * 按优先级加载：用户级(Claude) -> 项目级(Claude) -> 插件 -> 用户级(Sema) -> 项目级(Sema)
   * 后加载的覆盖先加载的，优先级从高到低：项目级(Sema) > 用户级(Sema) > 插件 > 项目级(Claude) > 用户级(Claude)
   */
  private async loadCommands(): Promise<void> {
    // 清空现有配置
    this.commandConfigs.clear()

    // 1. 用户级(Claude) - 最低优先级
    await this.loadCommandsFromDir(this.claudeUserCommandsDir, 'user', 'claude')

    // 2. 项目级(Claude)
    await this.loadCommandsFromDir(this.claudeProjectCommandsDir, 'project', 'claude')

    // 3. 插件 commands
    await this.loadCommandsFromPlugins()

    // 4. 用户级(Sema)
    await this.loadCommandsFromDir(this.semaUserCommandsDir, 'user', 'sema')

    // 5. 项目级(Sema) - 最高优先级
    await this.loadCommandsFromDir(this.semaProjectCommandsDir, 'project', 'sema')

    const commandNames = Array.from(this.commandConfigs.keys()).join(', ')
    logInfo(`加载 Commands 配置: ${commandNames}`)
  }

  /**
   * 从指定目录递归加载 command 配置
   * 每个 command 为 .md 文件，命令名由相对路径生成
   * Claude 来源为只读
   */
  private async loadCommandsFromDir(dirPath: string, scope: 'user' | 'project', from: 'sema' | 'claude'): Promise<void> {
    try {
      if (!fs.existsSync(dirPath)) {
        logDebug(`Commands 目录不存在: ${dirPath}`)
        return
      }

      const mdFiles = await this.scanMdFiles(dirPath)

      const parsePromises = mdFiles.map(filePath =>
        this.parseCommandFile(filePath, dirPath)
      )

      const commandConfigs = await Promise.all(parsePromises)

      let loadedCount = 0
      for (const commandConfig of commandConfigs) {
        if (commandConfig) {
          if (this.commandConfigs.has(commandConfig.name)) {
            logDebug(`Command [${commandConfig.name}] 被 ${from} ${scope} 级配置覆盖`)
          }
          this.commandConfigs.set(commandConfig.name, { ...commandConfig, locate: scope, from })
          loadedCount++
        }
      }

      if (loadedCount > 0) {
        logDebug(`加载 ${from} ${scope} 级 Commands: ${loadedCount} 个`)
      }
    } catch (error) {
      logError(`加载 ${from} ${scope} 级 Commands 失败 [${dirPath}]: ${error}`)
    }
  }

  /**
   * 从已安装且启用的插件中加载 commands
   * command 名格式：插件名:command名，locate 为 'plugin'
   */
  private async loadCommandsFromPlugins(): Promise<void> {
    try {
      const pluginsInfo = await getPluginsManager().getMarketplacePluginsInfo()
      const enabledPlugins = pluginsInfo.plugins.filter(p => p.status)

      let loadedCount = 0
      for (const plugin of enabledPlugins) {
        const commandComponents = (plugin.components as any).commands
        if (!Array.isArray(commandComponents)) continue

        for (const commandEntry of commandComponents) {
          const commandConfig = await this.parseCommandFile(commandEntry.filePath, path.dirname(commandEntry.filePath))
          if (commandConfig) {
            const pluginCommandName = `${plugin.name}:${commandEntry.name}`
            if (this.commandConfigs.has(pluginCommandName)) {
              logDebug(`Command [${pluginCommandName}] 被插件配置覆盖`)
            }
            this.commandConfigs.set(pluginCommandName, {
              ...commandConfig,
              name: pluginCommandName,
              locate: 'plugin',
              from: plugin.from
            })
            loadedCount++
          }
        }
      }

      if (loadedCount > 0) {
        logDebug(`加载插件 Commands: ${loadedCount} 个`)
      }
    } catch (error) {
      logError(`加载插件 Commands 失败: ${error}`)
    }
  }

  /**
   * 递归扫描目录中所有 .md 文件
   */
  private async scanMdFiles(dirPath: string): Promise<string[]> {
    const result: string[] = []

    const scan = async (dir: string): Promise<void> => {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          await scan(fullPath)
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          result.push(fullPath)
        }
      }
    }

    await scan(dirPath)
    return result
  }

  /**
   * 从文件路径生成命令名
   * 例如：frontend/test.md → frontend:test
   */
  private generateCommandName(filePath: string, baseDir: string): string {
    const relativePath = path.relative(baseDir, filePath)
    const withoutExt = relativePath.replace(/\.md$/i, '')
    return withoutExt.split(path.sep).join(':')
  }

  /**
   * 解析 Command Markdown 文件
   */
  private async parseCommandFile(filePath: string, baseDir: string): Promise<CommandConfig | null> {
    try {
      if (!fs.existsSync(filePath)) {
        return null
      }

      const { metadata, prompt } = parseFile(filePath)

      const name = this.generateCommandName(filePath, baseDir)
      const description = typeof metadata.description === 'string' ? metadata.description.trim() : ''
      const argumentHintRaw = metadata['argument-hint']
      let argumentHint: string | string[] | undefined
      if (typeof argumentHintRaw === 'string') {
        const trimmed = argumentHintRaw.trim()
        const matches = trimmed.match(/\[([^\]]+)\]/g)
        argumentHint = matches && matches.length > 0 ? matches.map(m => m.slice(1, -1)) : trimmed
      } else if (Array.isArray(argumentHintRaw)) {
        argumentHint = argumentHintRaw
      }
      const promptStr = prompt.trim()

      if (!name || !promptStr) {
        logWarn(`Command 文件格式错误 [${filePath}]: name/prompt 必须为非空字符串`)
        return null
      }

      return {
        name,
        description,
        argumentHint,
        prompt: promptStr,
        filePath
      }
    } catch (error) {
      logError(`解析 Command 文件失败 [${filePath}]: ${error}`)
      return null
    }
  }

  /**
   * 获取所有 Command 配置
   */
  private getCommandsConfs(): CommandConfig[] {
    return Array.from(this.commandConfigs.values())
  }

  /**
   * 获取所有 Command 信息（有缓存则直接返回，否则等待后台加载或重新加载）
   */
  async getCommandsInfo(): Promise<CommandConfig[]> {
    if (this.commandInfoCache) {
      return this.commandInfoCache
    }
    if (this.loadingPromise) {
      return this.loadingPromise
    }
    return this.refreshCommandsInfo()
  }

  /**
   * 刷新 Commands 信息
   * 重新加载所有配置，更新缓存
   */
  async refreshCommandsInfo(): Promise<CommandConfig[]> {
    logDebug('刷新 Commands 信息...')
    this.invalidateCache()

    await this.loadCommands()

    const commandInfos = this.getCommandsConfs().map(config => ({
      name: config.name,
      description: config.description,
      argumentHint: config.argumentHint,
      prompt: config.prompt,
      locate: config.locate,
      from: config.from,
      filePath: config.filePath
    }))

    this.commandInfoCache = commandInfos
    logInfo(`Commands 信息刷新完成: ${commandInfos.length} 个 Command`)
    return commandInfos
  }

  /**
   * 根据名称获取 Command 配置
   */
  getCommandConfig(name: string): CommandConfig | undefined {
    return this.commandConfigs.get(name)
  }

  /**
   * 解析 argumentHint 字符串为 string[]
   * 支持空格或逗号分隔，返回 null 表示格式无效
   */
  private parseArgumentHint(hint: string): string[] | null {
    if (typeof hint !== 'string' || !hint.trim()) {
      return null
    }
    const parts = hint.trim().split(/[\s,]+/).filter(t => t)
    return parts.length > 0 ? parts : null
  }

  /**
   * 将 argumentHint 字符串标准化：
   * - 含 [xxx] 括号时提取各括号内容为 string[]，如 '[pr-number] [priority]' → ['pr-number', 'priority']
   * - 无括号时保持原字符串，如 'Optional feature description' → 'Optional feature description'
   */
  private normalizeArgumentHint(hint: string): string | string[] {
    const matches = hint.match(/\[([^\]]+)\]/g)
    if (matches && matches.length > 0) {
      return matches.map(m => m.slice(1, -1))
    }
    return hint
  }

  /**
   * 生成 Command 文件内容（Markdown 格式）
   */
  private generateCommandFileContent(commandConf: CommandConfig): string {
    const lines = ['---']

    const description = commandConf.description
    if (description.includes(':') || description.includes('"') || description.includes("'")) {
      lines.push(`description: "${description.replace(/"/g, '\\"')}"`)
    } else {
      lines.push(`description: ${description}`)
    }

    if (commandConf.argumentHint) {
      lines.push(`argument-hint: ${commandConf.argumentHint}`)
    }

    lines.push('---')
    lines.push('')

    if (commandConf.prompt) {
      lines.push(commandConf.prompt)
    }

    return lines.join('\n')
  }

  /**
   * 保存 Command 配置到文件
   */
  private async saveCommandToFile(commandConf: CommandConfig): Promise<boolean> {
    try {
      const targetDir = commandConf.locate === 'user' ? this.semaUserCommandsDir : this.semaProjectCommandsDir
      const relativePath = commandConf.name.split(':').join(path.sep) + '.md'
      const filePath = path.join(targetDir, relativePath)
      const fileDir = path.dirname(filePath)

      if (!fs.existsSync(fileDir)) {
        await fsPromises.mkdir(fileDir, { recursive: true })
      }

      const content = this.generateCommandFileContent(commandConf)
      await fsPromises.writeFile(filePath, content, 'utf8')

      logInfo(`Command 配置已保存到文件: ${filePath}`)
      return true
    } catch (error) {
      logError(`保存 Command 配置到文件失败 [${commandConf.name}]: ${error}`)
      return false
    }
  }

  /**
   * 添加 Command 配置
   * 只能添加到 Sema 路径（Claude 为只读）
   * 必填：name、description、prompt、locate；选填：argumentHint
   */
  async addCommandConf(commandConf: CommandConfig): Promise<CommandConfig[]> {
    if (!commandConf.name || !commandConf.description || !commandConf.prompt) {
      logWarn(`添加 Command 失败: 缺少必需字段 name、description 或 prompt`)
      return this.getCommandsInfo()
    }

    if (!commandConf.locate || (commandConf.locate !== 'project' && commandConf.locate !== 'user')) {
      logWarn(`添加 Command 失败: locate 必须为 'project' 或 'user'`)
      return this.getCommandsInfo()
    }

    if (this.commandConfigs.has(commandConf.name)) {
      logWarn(`Command [${commandConf.name}] 被覆盖`)
    }

    if (typeof commandConf.argumentHint === 'string') {
      commandConf = { ...commandConf, argumentHint: this.normalizeArgumentHint(commandConf.argumentHint) }
    }

    this.commandConfigs.set(commandConf.name, { ...commandConf })
    this.invalidateCache()
    logInfo(`添加 Command 配置: ${commandConf.name}`)

    const saved = await this.saveCommandToFile(commandConf)
    if (!saved) {
      logWarn(`Command 配置已添加到内存，但保存到文件失败: ${commandConf.name}`)
    }

    return this.refreshCommandsInfo()
  }

  /**
   * 移除 Command 配置
   * Claude 来源为只读，不可移除；插件 Command 不可移除
   */
  async removeCommandConf(name: string): Promise<CommandConfig[]> {
    const commandConf = this.commandConfigs.get(name)
    if (!commandConf) {
      logWarn(`移除 Command 失败: 未找到 [${name}]`)
      return this.getCommandsInfo()
    }

    if (commandConf.from === 'claude') {
      logWarn(`移除 Command 失败: Claude 来源为只读 [${name}]`)
      return this.getCommandsInfo()
    }

    if (commandConf.locate === 'plugin') {
      logWarn(`移除 Command 失败: 插件 Command 不可移除 [${name}]`)
      return this.getCommandsInfo()
    }

    this.commandConfigs.delete(name)
    this.invalidateCache()

    // 删除 command 文件
    const targetDir = commandConf.locate === 'user' ? this.semaUserCommandsDir : this.semaProjectCommandsDir
    // 将命令名中的冒号还原为路径分隔符
    const relativePath = name.split(':').join(path.sep) + '.md'
    const commandFilePath = path.join(targetDir, relativePath)
    try {
      if (fs.existsSync(commandFilePath)) {
        await fsPromises.rm(commandFilePath)
        logInfo(`Command 文件已删除: ${commandFilePath}`)

        // 如果父目录为空则一并删除
        const parentDir = path.dirname(commandFilePath)
        if (parentDir !== targetDir) {
          const siblings = await fsPromises.readdir(parentDir)
          if (siblings.length === 0) {
            await fsPromises.rm(parentDir, { recursive: true })
            logDebug(`Command 空目录已删除: ${parentDir}`)
          }
        }
      }
    } catch (error) {
      logError(`删除 Command 文件失败 [${commandFilePath}]: ${error}`)
    }

    logInfo(`移除 Command 配置: ${name}`)
    return this.refreshCommandsInfo()
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.commandConfigs.clear()
    this.invalidateCache()
  }
}

// ===================== 全局 Commands 管理器 =====================

let commandsManagerInstance: CommandsManager | null = null

/**
 * 获取 Commands Manager 实例（单例模式）
 */
export function getCommandsManager(): CommandsManager {
  if (!commandsManagerInstance) {
    commandsManagerInstance = new CommandsManager()
  }
  return commandsManagerInstance
}

export { CommandsManager }

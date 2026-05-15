/**
 * Skills 管理器
 *
 * 管理自定义 Skill 的全局注册和查找
 * 实现优先级：插件 < 用户级 < 项目级
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { logDebug, logError, logInfo, logWarn } from '../../util/log'
import { getSemaRootDir } from '../../util/savePath'
import { readInitialCwd } from '../../util/cwd'
import { parseFile } from '../../util/formatter'
import { getPluginsManager } from '../plugins/pluginsManager'
import { SkillConfig } from '../../types/skill'


const SKILL_FILE_NAME = 'SKILL.md'

/**
 * Skills 管理器类 - 单例模式
 */
class SkillsManager {
  private semaUserSkillsDir: string     // ~/.sema/skills
  private semaProjectSkillsDir: string  // <project>/.sema/skills

  private skillConfigs: Map<string, SkillConfig> = new Map()
  // Skills 信息缓存
  private skillInfoCache: SkillConfig[] | null = null
  // 后台加载 Promise
  private loadingPromise: Promise<SkillConfig[]> | null = null

  constructor() {
    const semaRootDir = getSemaRootDir()
    this.semaUserSkillsDir = path.join(semaRootDir, 'skills')

    const cwd = readInitialCwd()
    this.semaProjectSkillsDir = path.join(cwd, '.sema', 'skills')

    // 后台静默加载 skills 信息
    this.loadingPromise = this.loadAndCacheSkills()
      .catch(err => {
        logError(`后台加载 Skills 信息失败: ${err}`)
        return [] as SkillConfig[]
      })
      .finally(() => { this.loadingPromise = null })
  }

  /**
   * 清空缓存
   */
  private invalidateCache(): void {
    this.skillInfoCache = null
  }

  /**
   * 加载 Skills 配置（内部方法）
   * 按优先级加载：插件 -> 用户级 -> 项目级
   * 后加载的覆盖先加载的
   */
  private async loadSkills(): Promise<void> {
    // 清空现有配置
    this.skillConfigs.clear()

    // 1. 插件 skills - 最低优先级
    await this.loadSkillsFromPlugins()

    // 2. 用户级
    await this.loadSkillsFromDir(this.semaUserSkillsDir, 'user')

    // 3. 项目级 - 最高优先级
    await this.loadSkillsFromDir(this.semaProjectSkillsDir, 'project')

    const skillNames = Array.from(this.skillConfigs.keys()).join(', ')
    logInfo(`加载 Skills 配置: ${skillNames}`)
  }

  /**
   * 从已安装且启用的插件中加载 skills
   * skill 名格式：插件名:skill名，locate 为 'plugin'
   */
  private async loadSkillsFromPlugins(): Promise<void> {
    try {
      const pluginsInfo = await getPluginsManager().getMarketplacePluginsInfo()
      const enabledPlugins = pluginsInfo.plugins.filter(p => p.status)

      let loadedCount = 0
      for (const plugin of enabledPlugins) {
        const skillComponents = (plugin.components as any).skills
        if (!Array.isArray(skillComponents)) continue

        for (const skillEntry of skillComponents) {
          const skillConfig = await this.parseSkillFile(skillEntry.filePath)
          if (skillConfig) {
            const pluginSkillName = `${plugin.name}:${skillConfig.name}`
            if (this.skillConfigs.has(pluginSkillName)) {
              logDebug(`Skill [${pluginSkillName}] 被插件配置覆盖`)
            }
            this.skillConfigs.set(pluginSkillName, {
              ...skillConfig,
              name: pluginSkillName,
              locate: 'plugin'
            })
            loadedCount++
          }
        }
      }

      if (loadedCount > 0) {
        logDebug(`加载插件 Skills: ${loadedCount} 个`)
      }
    } catch (error) {
      logError(`加载插件 Skills 失败: ${error}`)
    }
  }

  /**
   * 从指定目录加载 skill 配置
   * 每个 skill 存放于子目录中，子目录下有 SKILL.md 文件
   */
  private async loadSkillsFromDir(dirPath: string, scope: 'user' | 'project'): Promise<void> {
    try {
      if (!fs.existsSync(dirPath)) {
        logDebug(`Skills 目录不存在: ${dirPath}`)
        return
      }

      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
      const skillDirs = entries.filter(e => e.isDirectory())

      const parsePromises = skillDirs.map(dir => {
        const skillFilePath = path.join(dirPath, dir.name, SKILL_FILE_NAME)
        return this.parseSkillFile(skillFilePath)
      })

      const skillConfigs = await Promise.all(parsePromises)

      let loadedCount = 0
      for (const skillConfig of skillConfigs) {
        if (skillConfig) {
          if (this.skillConfigs.has(skillConfig.name)) {
            logDebug(`Skill [${skillConfig.name}] 被 ${scope} 级配置覆盖`)
          }
          this.skillConfigs.set(skillConfig.name, { ...skillConfig, locate: scope })
          loadedCount++
        }
      }

      if (loadedCount > 0) {
        logDebug(`加载 ${scope} 级 Skills: ${loadedCount} 个`)
      }
    } catch (error) {
      logError(`加载 ${scope} 级 Skills 失败 [${dirPath}]: ${error}`)
    }
  }

  /**
   * 解析 Skill Markdown 文件（SKILL.md）
   */
  private async parseSkillFile(filePath: string): Promise<SkillConfig | null> {
    try {
      if (!fs.existsSync(filePath)) {
        return null
      }

      const { metadata, prompt } = parseFile(filePath)

      const name = typeof metadata.name === 'string' ? metadata.name.trim() : ''
      const description = typeof metadata.description === 'string' ? metadata.description.trim() : ''
      const promptStr = prompt.trim()

      if (!name || !description || !promptStr) {
        throw new Error(`Skill 文件格式错误 [${filePath}]: name/description/prompt 必须为非空字符串`)
      }

      return {
        name,
        description,
        prompt: promptStr,
        filePath
      }
    } catch (error) {
      logError(`解析 Skill 文件失败 [${filePath}]: ${error}`)
      return null
    }
  }

  /**
   * 获取所有 Skill 配置
   */
  private getSkillsConfs(): SkillConfig[] {
    return Array.from(this.skillConfigs.values())
  }

  /**
   * 重新加载并缓存 Skills 信息
   */
  private async loadAndCacheSkills(): Promise<SkillConfig[]> {
    logDebug('刷新 Skills 信息...')
    this.invalidateCache()

    await this.loadSkills()

    const skillInfos = this.getSkillsConfs().map(config => ({
      name: config.name,
      description: config.description,
      prompt: config.prompt,
      locate: config.locate,
      filePath: config.filePath
    }))

    this.skillInfoCache = skillInfos
    logInfo(`Skills 信息刷新完成: ${skillInfos.length} 个 Skill`)
    return skillInfos
  }

  /**
   * 获取所有 Skill 信息
   * @param concise 简洁模式，返回的 prompt 字段为空字符串（UI 层一般用不上）
   * @param refresh 是否强制刷新（清缓存后重新加载）
   */
  async getSkillsInfo(concise?: boolean, refresh?: boolean): Promise<SkillConfig[]> {
    let infos: SkillConfig[]
    if (refresh) {
      infos = await this.loadAndCacheSkills()
    } else if (this.skillInfoCache) {
      infos = this.skillInfoCache
    } else if (this.loadingPromise) {
      infos = await this.loadingPromise
    } else {
      infos = await this.loadAndCacheSkills()
    }
    return concise ? infos.map(info => ({ ...info, prompt: '' })) : infos
  }

  /**
   * 根据名称获取 Skill 配置
   */
  getSkillConfig(name: string): SkillConfig | undefined {
    return this.skillConfigs.get(name)
  }

  /**
   * 获取所有 Skill 的类型描述
   * 格式: "- SkillName: description"
   */
  getSkillTypesDescription(): string {
    const skillsConfs = this.getSkillsConfs()
    if (skillsConfs.length === 0) {
      return ''
    }
    return skillsConfs
      .map(skill => `- ${skill.name}: ${skill.description}`)
      .join('\n')
  }

  /**
   * 移除 Skill 配置
   * 插件 Skill 不可移除
   */
  async removeSkillConf(name: string): Promise<SkillConfig[]> {
    const skillConf = this.skillConfigs.get(name)
    if (!skillConf) {
      logWarn(`移除 Skill 失败: 未找到 [${name}]`)
      return this.getSkillsInfo()
    }

    if (skillConf.locate === 'plugin') {
      logWarn(`移除 Skill 失败: 插件 Skill 不可移除 [${name}]`)
      return this.getSkillsInfo()
    }

    this.skillConfigs.delete(name)
    this.invalidateCache()

    // 删除 SKILL.md 所在目录
    const targetDir = skillConf.locate === 'user' ? this.semaUserSkillsDir : this.semaProjectSkillsDir
    const skillDirPath = skillConf.filePath ? path.dirname(skillConf.filePath) : path.join(targetDir, name)
    try {
      if (fs.existsSync(skillDirPath)) {
        await fsPromises.rm(skillDirPath, { recursive: true })
        logInfo(`Skill 目录已删除: ${skillDirPath}`)

        // 如果父目录为空则一并删除
        const parentDir = path.dirname(skillDirPath)
        if (parentDir !== targetDir) {
          const siblings = await fsPromises.readdir(parentDir)
          if (siblings.length === 0) {
            await fsPromises.rm(parentDir, { recursive: true })
            logDebug(`Skill 空目录已删除: ${parentDir}`)
          }
        }
      }
    } catch (error) {
      logError(`删除 Skill 目录失败 [${skillDirPath}]: ${error}`)
    }

    logInfo(`移除 Skill 配置: ${name}`)
    return this.loadAndCacheSkills()
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.skillConfigs.clear()
    this.invalidateCache()
  }
}

// ===================== 全局 Skills 管理器 =====================

let skillsManagerInstance: SkillsManager | null = null

/**
 * 获取 Skills Manager 实例（单例模式）
 */
export function getSkillsManager(): SkillsManager {
  if (!skillsManagerInstance) {
    skillsManagerInstance = new SkillsManager()
  }
  return skillsManagerInstance
}

export function getSkillTypesDescription(): string {
  return getSkillsManager().getSkillTypesDescription()
}

export { SkillsManager }

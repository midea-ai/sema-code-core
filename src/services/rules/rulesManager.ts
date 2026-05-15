/**
 * Rule 管理器
 *
 * 管理 Rule 配置的全局加载和查找
 * 实现优先级：用户级(Sema) < 项目级(Sema)
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { logDebug, logError, logInfo } from '../../util/log'
import { getSemaRootDir } from '../../util/savePath'
import { readInitialCwd } from '../../util/cwd'
import { RuleConfig } from '../../types/rule'

const AGENTS_FILE_NAME = 'AGENTS.md'

/**
 * Rule 管理器类 - 单例模式
 */
class RuleManager {
  private semaUserRuleFile: string     // ~/.sema/AGENTS.md
  private semaProjectRuleFile: string  // <project>/AGENTS.md

  private ruleInfoCache: RuleConfig | null | undefined = undefined
  private loadingPromise: Promise<RuleConfig | null> | null = null

  constructor() {
    const semaRootDir = getSemaRootDir()
    this.semaUserRuleFile = path.join(semaRootDir, AGENTS_FILE_NAME)

    const cwd = readInitialCwd()
    this.semaProjectRuleFile = path.join(cwd, AGENTS_FILE_NAME)

    // 后台静默加载 rules 信息
    this.loadingPromise = this.loadAndCacheRule()
      .catch(err => {
        logError(`后台加载 Rule 信息失败: ${err}`)
        return null
      })
      .finally(() => { this.loadingPromise = null })
  }

  private invalidateCache(): void {
    this.ruleInfoCache = undefined
  }

  /**
   * 从文件加载 RuleConfig
   */
  private async loadRuleFromFile(filePath: string, locate: 'user' | 'project', from: string): Promise<RuleConfig | null> {
    try {
      if (!fs.existsSync(filePath)) {
        logDebug(`Rule 文件不存在: ${filePath}`)
        return null
      }

      const prompt = (await fsPromises.readFile(filePath, 'utf-8')).trim()
      if (!prompt) {
        logDebug(`Rule 文件内容为空: ${filePath}`)
        return null
      }

      return { prompt, locate, from, filePath }
    } catch (error) {
      logError(`加载 Rule 失败 [${filePath}]: ${error}`)
      return null
    }
  }

  /**
   * 加载 Rule 配置
   * 按优先级从高到低取第一个存在的：项目级(Sema) > 用户级(Sema)
   */
  private async loadRule(): Promise<RuleConfig | null> {
    // 1. 项目级(Sema) - 最高优先级
    const semaProjectRule = await this.loadRuleFromFile(this.semaProjectRuleFile, 'project', 'sema')
    if (semaProjectRule) {
      logInfo('加载 Rule 配置: sema project')
      return semaProjectRule
    }

    // 2. 用户级(Sema)
    const semaUserRule = await this.loadRuleFromFile(this.semaUserRuleFile, 'user', 'sema')
    if (semaUserRule) {
      logInfo('加载 Rule 配置: sema user')
      return semaUserRule
    }

    logInfo('加载 Rule 配置: 无')
    return null
  }

  /**
   * 重新加载并缓存 Rule 信息
   */
  private async loadAndCacheRule(): Promise<RuleConfig | null> {
    logDebug('刷新 Rule 信息...')
    this.invalidateCache()

    const rule = await this.loadRule()
    this.ruleInfoCache = rule
    logInfo(`Rule 信息刷新完成: ${rule ? rule.from : '无'}`)
    return rule
  }

  /**
   * 获取 Rule 信息
   * @param refresh 是否强制刷新（清缓存后重新加载）
   */
  async getRuleInfo(refresh?: boolean): Promise<RuleConfig | null> {
    if (refresh) return this.loadAndCacheRule()
    if (this.ruleInfoCache !== undefined) return this.ruleInfoCache
    if (this.loadingPromise) return this.loadingPromise
    return this.loadAndCacheRule()
  }

  /**
   * 同步获取 rules 描述（从缓存中读取）
   * 缓存未就绪时返回空字符串
   */
  getRuleDescription(): string {
    const rule = this.ruleInfoCache
    if (!rule || !rule.prompt) return ''
    const filePath = rule.filePath ?? ''
    const header = filePath
      ? `Contents of ${filePath} (user's private global instructions for all projects):`
      : `Project Rule:`
    return `${header}\n\n${rule.prompt}`
  }

  dispose(): void {
    this.invalidateCache()
  }
}

// ===================== 全局 Rule 管理器 =====================

let rulesManagerInstance: RuleManager | null = null

/**
 * 获取 Rule Manager 实例（单例模式）
 */
export function getRuleManager(): RuleManager {
  if (!rulesManagerInstance) {
    rulesManagerInstance = new RuleManager()
  }
  return rulesManagerInstance
}

export function getRuleDescription(): string {
  return getRuleManager().getRuleDescription()
}

export { RuleManager }

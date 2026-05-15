/**
 * Memory 管理器
 *
 * 管理自定义 Memory 的全局注册和查找
 * 仅使用 Sema 路径：<project>/.sema/memory
 */

import * as fs from 'fs'
import { promises as fsPromises } from 'fs'
import * as path from 'path'
import { logDebug, logError, logInfo } from '../../util/log'
import { readInitialCwd } from '../../util/cwd'
import { MemoryConfig } from '../../types/memory'

const MEMORY_FILE_NAME = 'MEMORY.md'

/**
 * Memory 管理器类 - 单例模式
 */
class MemoryManager {
  private semaProjectMemoryDir: string    // <project>/.sema/memory

  private memoryInfoCache: MemoryConfig | null | undefined = undefined
  private loadingPromise: Promise<MemoryConfig | null> | null = null

  constructor() {
    const cwd = readInitialCwd()
    this.semaProjectMemoryDir = path.join(cwd, '.sema', 'memory')

    // 后台静默加载 memory 信息
    this.loadingPromise = this.loadAndCacheMemory()
      .catch(err => {
        logError(`后台加载 Memory 信息失败: ${err}`)
        return null
      })
      .finally(() => { this.loadingPromise = null })
  }

  private invalidateCache(): void {
    this.memoryInfoCache = undefined
  }

  /**
   * 从目录加载 MemoryConfig
   * 目录下 MEMORY.md 为主 prompt，其他 .md 文件为引用文件
   */
  private async loadMemoryFromDir(dirPath: string, from: string): Promise<MemoryConfig | null> {
    try {
      if (!fs.existsSync(dirPath)) {
        logDebug(`Memory 目录不存在: ${dirPath}`)
        return null
      }

      const memoryFilePath = path.join(dirPath, MEMORY_FILE_NAME)
      if (!fs.existsSync(memoryFilePath)) {
        logDebug(`Memory 文件不存在: ${memoryFilePath}`)
        return null
      }

      const prompt = (await fsPromises.readFile(memoryFilePath, 'utf-8')).trim()
      if (!prompt) {
        logDebug(`Memory 文件内容为空: ${memoryFilePath}`)
        return null
      }

      // 收集目录下其他 .md 文件路径
      const entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
      const refFilePath = entries
        .filter(e => e.isFile() && e.name.endsWith('.md') && e.name !== MEMORY_FILE_NAME)
        .map(e => path.join(dirPath, e.name))

      return {
        prompt,
        from,
        FilePath: memoryFilePath,
        refFilePath: refFilePath.length > 0 ? refFilePath : undefined
      }
    } catch (error) {
      logError(`加载 Memory 失败 [${dirPath}]: ${error}`)
      return null
    }
  }

  /**
   * 加载 Memory 配置
   */
  private async loadMemory(): Promise<MemoryConfig | null> {
    const memory = await this.loadMemoryFromDir(this.semaProjectMemoryDir, 'sema')
    if (memory) {
      logInfo('加载 Memory 配置: sema')
      return memory
    }

    logInfo('加载 Memory 配置: 无')
    return null
  }

  /**
   * 重新加载并缓存 Memory 信息
   */
  private async loadAndCacheMemory(): Promise<MemoryConfig | null> {
    logDebug('刷新 Memory 信息...')
    this.invalidateCache()

    const memory = await this.loadMemory()
    this.memoryInfoCache = memory
    logInfo(`Memory 信息刷新完成: ${memory ? memory.from : '无'}`)
    return memory
  }

  /**
   * 获取 Memory 信息
   * @param refresh 是否强制刷新（清缓存后重新加载）
   */
  async getMemoryInfo(refresh?: boolean): Promise<MemoryConfig | null> {
    if (refresh) return this.loadAndCacheMemory()
    if (this.memoryInfoCache !== undefined) return this.memoryInfoCache
    if (this.loadingPromise) return this.loadingPromise
    return this.loadAndCacheMemory()
  }

  getActiveMemoryDir(): string {
    return path.join(this.semaProjectMemoryDir, 'MEMORY.md')
  }

  /**
   * 同步获取 memory 描述（从缓存中读取）
   * 缓存未就绪时返回空字符串
   */
  getMemoryDescription(): string {
    const memory = this.memoryInfoCache
    if (!memory || !memory.prompt) return ''
    const filePath = memory.FilePath ?? ''
    const header = filePath
      ? `Contents of ${filePath} (user's auto-memory, persists across conversations):`
      : `Project Memory:`
    return `${header}\n\n${memory.prompt}`
  }

  dispose(): void {
    this.invalidateCache()
  }
}

// ===================== 全局 Memory 管理器 =====================

let memoryManagerInstance: MemoryManager | null = null

/**
 * 获取 Memory Manager 实例（单例模式）
 */
export function getMemoryManager(): MemoryManager {
  if (!memoryManagerInstance) {
    memoryManagerInstance = new MemoryManager()
  }
  return memoryManagerInstance
}

export function getMemoryDescription(): string {
  return getMemoryManager().getMemoryDescription()
}

export { MemoryManager }

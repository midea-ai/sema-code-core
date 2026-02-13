import crypto from 'crypto'
import * as fs from 'fs'
import { AssistantMessage, UserMessage } from '../types/message'
import { getCacheDir, getLLMCacheFilePath } from './savePath'

// 缓存项接口
interface CacheEntry {
  key: string
  response: AssistantMessage
  timestamp: number
}

// llm缓存实现
class FileLLMCache {
  private readonly maxEntries = 100
  private readonly cacheFilePath: string

  constructor() {
    this.cacheFilePath = getLLMCacheFilePath()
    this.ensureCacheDir()
  }

  /**
   * 确保缓存目录存在
   */
  private ensureCacheDir(): void {
    const cacheDir = getCacheDir()
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }
  }

  /**
   * 生成缓存键 - 基于消息内容生成简单hash
   */
  private generateKey(
    messages: (UserMessage | AssistantMessage)[],
    systemPrompt: string[] | Array<{ type: 'text', text: string }>,
    modelName: string,
    enableThinking: boolean = false
  ): string {
    // 统一处理系统提示格式
    const normalizedSystemPrompt = Array.isArray(systemPrompt) && systemPrompt.length > 0 && typeof systemPrompt[0] === 'object' && 'type' in systemPrompt[0]
      ? (systemPrompt as Array<{ type: 'text', text: string }>).map(item => item.text)
      : systemPrompt as string[]

    const content = JSON.stringify({
      messages: messages.map(msg => msg.message.content),
      systemPrompt: normalizedSystemPrompt,
      modelName,
      enableThinking
    })
    return crypto.createHash('md5').update(content).digest('hex')
  }

  /**
   * 读取缓存文件
   */
  private readCacheFile(): CacheEntry[] {
    try {
      if (!fs.existsSync(this.cacheFilePath)) {
        return []
      }
      const data = fs.readFileSync(this.cacheFilePath, 'utf8')
      return JSON.parse(data) || []
    } catch (error) {
      // 文件损坏或不存在，返回空数组
      return []
    }
  }

  /**
   * 写入缓存文件
   */
  private writeCacheFile(entries: CacheEntry[]): void {
    try {
      fs.writeFileSync(this.cacheFilePath, JSON.stringify(entries, null, 2), 'utf8')
    } catch (error) {
      // 写入失败，忽略错误
    }
  }

  /**
   * 获取缓存
   */
  get(
    messages: (UserMessage | AssistantMessage)[],
    systemPrompt: string[] | Array<{ type: 'text', text: string }>,
    modelName: string,
    enableThinking: boolean = false
  ): AssistantMessage | null {
    const key = this.generateKey(messages, systemPrompt, modelName, enableThinking)
    const entries = this.readCacheFile()

    const entry = entries.find(e => e.key === key)
    return entry ? entry.response : null
  }

  /**
   * 设置缓存
   */
  set(
    messages: (UserMessage | AssistantMessage)[],
    systemPrompt: string[] | Array<{ type: 'text', text: string }>,
    modelName: string,
    response: AssistantMessage,
    enableThinking: boolean = false
  ): void {
    const key = this.generateKey(messages, systemPrompt, modelName, enableThinking)
    let entries = this.readCacheFile()

    // 移除已存在的相同key
    entries = entries.filter(e => e.key !== key)

    // 添加新条目
    entries.unshift({
      key,
      response,
      timestamp: Date.now()
    })

    // 保持最多n条记录
    if (entries.length > this.maxEntries) {
      entries = entries.slice(0, this.maxEntries)
    }

    this.writeCacheFile(entries)
  }

  /**
   * 清空缓存
   */
  clear(): void {
    try {
      if (fs.existsSync(this.cacheFilePath)) {
        fs.unlinkSync(this.cacheFilePath)
      }
    } catch (error) {
      // 删除失败，忽略错误
    }
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    const entries = this.readCacheFile()
    return entries.length
  }
}

// 全局缓存实例
export const llmCache = new FileLLMCache()
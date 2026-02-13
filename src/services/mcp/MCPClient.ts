/**
 * MCP 客户端 - 负责与单个 MCP Server 的通信
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  MCPServerConfig,
  MCPServerCapabilities,
  MCPToolResult,
  MCPServerStatus,
  MCPToolDefinition
} from '../../types/mcp'
import { logDebug, logError } from '../../util/log'

type Transport = StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

export class MCPClient {
  private client: Client
  private transport: Transport | null = null
  private _status: MCPServerStatus = 'disconnected'
  private _capabilities: MCPServerCapabilities | null = null

  constructor(private config: MCPServerConfig) {
    this.client = new Client(
      {
        name: 'sema-core',
        version: '1.0.0'
      },
      {
        capabilities: {}
      }
    )
  }

  get status(): MCPServerStatus {
    return this._status
  }

  get capabilities(): MCPServerCapabilities | null {
    return this._capabilities
  }

  /** 连接超时时间 (ms) */
  private static readonly CONNECT_TIMEOUT = 30000

  /**
   * 连接到 MCP Server
   */
  async connect(): Promise<void> {
    try {
      this._status = 'connecting'

      // 根据传输类型创建 transport
      this.transport = this.createTransport()

      // 带超时的连接
      await this.withTimeout(
        this.client.connect(this.transport),
        MCPClient.CONNECT_TIMEOUT,
        `连接超时 (${MCPClient.CONNECT_TIMEOUT / 1000}s)`
      )

      // 获取能力（也需要超时保护）
      await this.withTimeout(
        this.fetchCapabilities(),
        MCPClient.CONNECT_TIMEOUT,
        `获取能力超时 (${MCPClient.CONNECT_TIMEOUT / 1000}s)`
      )

      this._status = 'connected'
      logDebug(`MCP Server [${this.config.name}] 连接成功`)
    } catch (error) {
      this._status = 'error'
      const errorMsg = error instanceof Error ? error.message : String(error)
      logError(`MCP Server [${this.config.name}] 连接失败: ${errorMsg}`)
      throw error
    }
  }

  /**
   * 带超时的 Promise 包装
   */
  private async withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timeoutId: NodeJS.Timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), ms)
    })
    try {
      return await Promise.race([promise, timeoutPromise])
    } finally {
      clearTimeout(timeoutId!)
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this._status === 'disconnected') {
      return
    }

    this._status = 'disconnected'
    this._capabilities = null

    try {
      // 先尝试优雅关闭客户端
      if (this.client) {
        await this.withTimeout(
          this.client.close(),
          5000, // 5秒超时
          '关闭客户端超时'
        )
      }
      logDebug(`MCP Server [${this.config.name}] 已断开`)
    } catch (error) {
      // 记录错误但不抛出，确保清理流程继续
      logError(`MCP Server [${this.config.name}] 断开失败: ${error}`)
    } finally {
      // 确保 transport 被清理
      try {
        if (this.transport) {
          // 对于 stdio transport，强制关闭可能仍在运行的子进程
          if (this.config.transport === 'stdio' && 'close' in this.transport) {
            ;(this.transport as any).close?.()
          }
          this.transport = null
        }
      } catch (transportError) {
        // 忽略 transport 清理错误
        logDebug(`Transport 清理错误 [${this.config.name}]: ${transportError}`)
      }
    }
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<MCPToolResult> {
    if (this._status !== 'connected') {
      throw new Error(`MCP Server [${this.config.name}] 未连接`)
    }

    const result = await this.client.callTool({
      name: toolName,
      arguments: args
    })

    return {
      content: result.content as MCPToolResult['content'],
      isError: result.isError as boolean | undefined
    }
  }

  private createTransport(): Transport {
    switch (this.config.transport) {
      case 'stdio':
        if (!this.config.command) {
          throw new Error('stdio 传输需要配置 command')
        }
        return new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env: this.config.env as Record<string, string> | undefined,
          // cwd: this.config.cwd
        })

      case 'sse':
        if (!this.config.url) {
          throw new Error('sse 传输需要配置 url')
        }
        return new SSEClientTransport(new URL(this.config.url))

      case 'http':
        if (!this.config.url) {
          throw new Error('http 传输需要配置 url')
        }
        return new StreamableHTTPClientTransport(new URL(this.config.url), {
          requestInit: this.config.headers ? { headers: this.config.headers } : undefined
        })

      default:
        throw new Error(`不支持的传输类型: ${this.config.transport}`)
    }
  }

  private async fetchCapabilities(): Promise<void> {
    try {
      const toolsResult = await this.client.listTools()
      this._capabilities = {
        tools: toolsResult.tools as MCPToolDefinition[]
      }
    } catch {
      this._capabilities = { tools: [] }
    }
  }
}

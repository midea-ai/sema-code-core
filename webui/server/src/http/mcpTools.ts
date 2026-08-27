/**
 * MCP 工具列表探测：按需短连（连接 → listTools → 断开），不常驻连接。
 * 会话 worker 里的 core 各自维护自己的 MCP 连接，这里只为插件页展示服务；
 * 结果按配置内容缓存在内存，配置被编辑后自动失效，refresh 强制重连。
 * 连接方式与 core 的 MCPClient 对齐（stdio/sse/http，transport 兼容 type 字段）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readUserMcp } from './ecosystem';
import type { EcoMcpTool } from '../../../shared/types';

const CONNECT_TIMEOUT = 20_000;

/** 缓存与去重都按 server 名；key 是配置序列化，配置变了自动失效 */
const cache = new Map<string, { key: string; tools: EcoMcpTool[] }>();
const inflight = new Map<string, Promise<EcoMcpTool[]>>();

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function createTransport(config: any) {
  const transport = config.transport || config.type || 'stdio';
  switch (transport) {
    case 'stdio':
      if (!config.command) throw new Error('stdio 传输需要配置 command');
      return new StdioClientTransport({
        command: config.command,
        args: Array.isArray(config.args) ? config.args : undefined,
        env: config.env && typeof config.env === 'object' ? { ...process.env as Record<string, string>, ...config.env } : undefined,
      });
    case 'sse':
      if (!config.url) throw new Error('sse 传输需要配置 url');
      return new SSEClientTransport(new URL(config.url));
    case 'http':
      if (!config.url) throw new Error('http 传输需要配置 url');
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    default:
      throw new Error(`不支持的传输类型: ${transport}`);
  }
}

async function probe(config: any): Promise<EcoMcpTool[]> {
  const client = new Client({ name: 'semawork', version: '1.0.0' }, { capabilities: {} });
  try {
    await withTimeout(client.connect(createTransport(config)), CONNECT_TIMEOUT, `连接超时 (${CONNECT_TIMEOUT / 1000}s)`);
    const result = await withTimeout(client.listTools(), CONNECT_TIMEOUT, `获取工具列表超时 (${CONNECT_TIMEOUT / 1000}s)`);
    return (result.tools || []).map(t => ({ name: t.name, description: t.description }));
  } finally {
    // 关闭失败不影响结果（stdio 子进程由 SDK close 兜底回收）
    await withTimeout(client.close(), 5_000, 'close timeout').catch(() => undefined);
  }
}

/** 探测指定用户级 MCP server 的工具列表；同名并发请求共享一次探测 */
export function listMcpTools(id: string, refresh: boolean): Promise<EcoMcpTool[]> {
  const config = (readUserMcp().mcpServers || {})[id];
  if (!config) throw new Error(`MCP server 不存在: ${id}`);
  const key = JSON.stringify(config);
  const cached = cache.get(id);
  if (!refresh && cached && cached.key === key) return Promise.resolve(cached.tools);
  const running = inflight.get(id);
  if (running) return running;
  const task = probe(config)
    .then(tools => { cache.set(id, { key, tools }); return tools; })
    .finally(() => inflight.delete(id));
  inflight.set(id, task);
  return task;
}

#!/usr/bin/env node
// Sema 浏览器控制：桥接进程。由 sema-core 按 .mcp.json 以 stdio 方式拉起，对外是 MCP 服务，
// 对内经本机套接字把工具调用交给原生宿主转发到扩展。启动时顺手把原生宿主清单写好。
import { createRequire } from 'node:module'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ensureNativeHostInstalled } from './lib/manifest.js'
import { BridgeError, HostClient } from './lib/client.js'
import { formatError, formatResult, tools } from './lib/tools.js'
import { runUpload } from './lib/upload.js'

const { version } = createRequire(import.meta.url)('./package.json')

// stdout 归 MCP，日志一律走 stderr
try {
  const r = ensureNativeHostInstalled()
  if (r.changed) console.error(`[sema-chrome] native host manifest written: ${r.manifestPaths.join(', ')}`)
} catch (e) {
  console.error(`[sema-chrome] native host manifest not written: ${e.message}`)
}

const client = new HostClient()
const server = new Server({ name: 'sema-chrome', version }, { capabilities: { tools: {} } })

// 经 npx 拉起时链路是 npx → sh → 本进程，宿主应用退出只 kill 得到 npx；stdin 关闭就是宿主应用走了，自己退出，别留孤儿
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const name = params.name
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
  if (!tools.some((t) => t.name === name)) {
    return errorResult(new BridgeError('bad_request', `Unknown tool: ${name}`))
  }
  try {
    // file_upload 在桥接进程里展开成 upload_begin / upload_chunk / upload_commit，其余工具名即扩展方法名
    const result = name === 'file_upload' ? await runUpload(client, args) : await client.request(name, args)
    const formatted = formatResult(name, result)
    // 截图返回 content 数组（图片块加文字），其余是文本
    return { content: Array.isArray(formatted) ? formatted : [{ type: 'text', text: formatted }] }
  } catch (e) {
    return errorResult(e instanceof BridgeError ? e : new BridgeError('internal', String(e?.message || e)))
  }
})

function errorResult(err) {
  return { content: [{ type: 'text', text: formatError(err) }], isError: true }
}

await server.connect(new StdioServerTransport())

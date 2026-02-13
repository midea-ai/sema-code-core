# MCP 集成

MCP（Model Context Protocol）是 Anthropic 主导的开放标准，允许 AI 应用通过统一协议接入外部工具和数据源。

## 架构

```
┌──────────────────────────────────────────────────┐
│                  Sema Core                       │
│                                                  │
│  MCPManager（单例）                               │
│  ├─ MCPClient A ──── stdio ──── 本地子进程 A       │
│  ├─ MCPClient B ──── sse  ──── 远程服务 B          │
│  └─ MCPClient C ──── http ──── HTTP 服务 C        │
│                                                  │
│  MCPToolAdapter                                  │
│  └─ 将 MCP 工具转换为 Sema Tool 接口                │
└──────────────────────────────────────────────────┘
```

- **MCPManager**：单例，管理所有 MCP 服务器的生命周期
- **MCPClient**：单个服务器连接，处理协议通信
- **MCPToolAdapter**：将 MCP 工具定义适配为 Sema `Tool` 接口


## 传输方式

| 方式 | 适用场景 | 配置字段 |
|------|---------|---------|
| `stdio` | 本地子进程（推荐） | `command`, `args`, `env` |
| `sse` | 远程 SSE 服务 | `url` |
| `http` | 远程 HTTP 服务 | `url`, `headers` |


## 作用域

| 作用域 | 配置文件 | 适用范围 |
|--------|---------|---------|
| `'user'` | `~/.sema/mcp.json` | 所有项目 |
| `'project'` | `.sema/mcp.json` | 仅当前项目 |

两个作用域的 MCP 服务器会合并使用，名称冲突时项目级优先。


## 完整配置示例

### stdio 本地子进程

```javascript
await sema.addOrUpdateMCPServer(
  {
    name: 'filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/dev/projects'],
    env: { NODE_ENV: 'production' },
    enabled: true,
  },
  'user'
)
```

### SSE 远程服务

```javascript
await sema.addOrUpdateMCPServer(
  {
    name: 'my-api-tools',
    transport: 'sse',
    url: 'https://api.example.com/mcp/sse',
  },
  'project'
)
```

### HTTP 远程服务（支持自定义请求头）

```javascript
await sema.addOrUpdateMCPServer(
  {
    name: 'my-api-tools',
    transport: 'http',
    url: 'https://api.example.com/mcp',
    headers: {
      Authorization: `Bearer ${process.env.API_TOKEN}`,
      'X-Client-Version': '1.0.0',
    },
  },
  'project'
)
```


## 工具命名与权限

MCP 工具在 Sema 内的完整名称格式：

```
mcp__[serverName]__[toolName]

示例:
  服务器: filesystem
  工具:   read_file
  完整名: mcp__filesystem__read_file
```

权限 key 使用完整工具名（含 `mcp__` 前缀），存储在 `allowedTools` 中：

```json
"allowedTools": ["mcp__filesystem__read_file"]
```


## 管理 API

```javascript
// 添加或更新服务器（若已存在则更新配置）
const info = await sema.addOrUpdateMCPServer(config, scope)

// 移除服务器
await sema.removeMCPServer('filesystem', 'user')

// 重新连接（服务器重启后）
const info = await sema.connectMCPServer('filesystem')

// 只使用部分工具
sema.updateMCPUseTools('filesystem', ['read_file', 'write_file'])
sema.updateMCPUseTools('filesystem', null)  // 恢复所有

// 查看所有配置
const configs = sema.getMCPServerConfigs()
// Map { 'user' => [...], 'project' => [...] }
```

`MCPServerInfo` 结构：

```javascript
interface MCPServerInfo {
  config: MCPServerConfig
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  capabilities?: MCPServerCapabilities  // 服务器能力（含工具列表）
  error?: string
  connectedAt?: number
}
```


## 连接生命周期

```
addOrUpdateMCPServer()
   │
   ▼
保存配置到文件
   │
   ▼
尝试连接服务器（MCPClient.connect()）
   ├─ 成功 → status: 'connected'，加载工具列表
   └─ 失败 → status: 'error'，记录错误信息

dispose()
   │
   ▼
断开所有连接，终止子进程
```


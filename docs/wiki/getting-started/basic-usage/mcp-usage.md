# MCP 使用指南

MCP（Model Context Protocol）是一种标准协议，允许为 AI 扩展自定义工具能力。通过 MCP，任何外部服务都能以标准化方式为 Sema 提供工具。

<figure align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/mcp.png" alt="model-list">
  <figcaption>Sema Code vscode 插件页面截图</figcaption>
</figure>

![MCP 演示](https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/mcp.gif)


## 快速开始

### 添加第一个 MCP 服务器

```javascript
// 添加 sequential-thinking 服务器（npx 方式）
await sema.addMCPServer({
  name: 'sequential-thinking',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  scope: 'user',  // 'user' | 'project' | 'local' | 'plugin'
})

// 添加 filesystem 服务器
await sema.addMCPServer({
  name: 'filesystem',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  scope: 'project',
})
```

## MCPServerConfig 接口

```typescript
interface MCPServerConfig {
  name: string                          // 服务器唯一名称
  description?: string                  // 服务描述
  transport: 'stdio' | 'sse' | 'http'   // 传输方式
  enabled?: boolean                     // 是否启用，默认 true
  useTools?: string[] | null            // 过滤工具列表，null 表示所有

  // stdio 模式
  command?: string                      // 可执行命令
  args?: string[]                       // 命令参数
  env?: Record<string, string>          // 环境变量

  // sse / http 模式
  url?: string                          // 服务地址
  headers?: Record<string, string>      // 请求头

  scope: 'user' | 'project' | 'local' | 'plugin'  // 作用域
}
```

## 配置文件位置与优先级

MCP 配置从多个来源加载，按优先级从高到低，后加载的覆盖先加载的：

| 优先级 | 来源 | 配置文件路径 |
|-------|------|-------------|
| 1（最高） | Sema 项目级 | `<project>/.sema/.mcp.json` |
| 2 | Sema 用户级 | `~/.sema/.mcp.json` |
| 3 | 插件 MCP | 已启用插件的 MCP 组件 |

> **注意**：
> - 插件来源的 MCP 服务器名称格式为 `plugin:插件名:server 名`
> - 服务启用/禁用状态保存在 `.sema/settings.json` 的 `disabledMcpServers` 字段
> - 工具过滤配置保存在 `.sema/settings.json` 的 `enabledMcpServerUseTools` 字段

## 管理 MCP 服务器

### 添加服务器

```javascript
// stdio 模式（本地子进程，推荐）
await sema.addMCPServer({
  name: 'time',
  transport: 'stdio',
  command: 'uvx',
  args: ['mcp-server-time'],
  scope: 'project',
})

// HTTP 模式
await sema.addMCPServer({
  name: 'remote-search',
  transport: 'http',
  url: 'https://mcp.example.com/api',
  headers: { Authorization: 'Bearer xxx' },
  scope: 'user',
})

// SSE 模式
await sema.addMCPServer({
  name: 'streaming-service',
  transport: 'sse',
  url: 'https://mcp.example.com/sse',
  scope: 'user',
})
```

### 移除服务器

```javascript
await sema.removeMCPServer('sequential-thinking')
```

### 重新连接

```javascript
await sema.reconnectMCPServer('time')
```

### 启用/禁用

```javascript
// 禁用（不断开配置，仅标记为不生效）
await sema.disableMCPServer('time')

// 启用（会尝试连接）
await sema.enableMCPServer('time')
```

### 限定工具列表

```javascript
// 仅允许 filesystem 服务器使用 read_file 和 write_file 工具
await sema.updateMCPUseTools('filesystem', ['read_file', 'write_file'])

// 恢复使用所有工具
await sema.updateMCPUseTools('filesystem', null)
```

## 查看 MCP 服务器

### 获取服务器信息

```javascript
// 获取（含缓存）
const servers = await sema.getMCPServerInfo()

// 强制刷新（从磁盘重新加载并连接）
const fresh = await sema.refreshMCPServerInfo()

// 遍历查看
servers.forEach(s => {
  console.log(`${s.config.name} [${s.scope}] ${s.connectStatus}`)
  console.log(`  启用状态：${s.status}`)
  console.log(`  可用工具：${s.capabilities?.tools?.length ?? 0}`)
  if (s.error) {
    console.log(`  错误：${s.error}`)
  }
})
```

### MCPServerInfo 接口

```typescript
interface MCPServerInfo {
  config: MCPServerConfig                    // 服务器配置
  connectStatus: 'disconnected' | 'connecting' | 'connected' | 'error'  // 连接状态
  capabilities?: {                           // 服务器能力
    tools?: MCPToolDefinition[]
  }
  connectedAt?: number                       // 连接时间戳
  status: boolean                            // 是否启用（≠ 是否已连接）
  error?: string                             // 错误信息
  scope?: 'user' | 'project' | 'local' | 'plugin'
  filePath?: string                          // 配置文件路径
}
```

### MCPToolDefinition 接口

```typescript
interface MCPToolDefinition {
  name: string
  description?: string
  toolParams: {
    type: 'object'
    properties?: Record<string, any>
    required?: string[]
  }
}
```

## 工具命名规则

MCP 工具在 Sema 中以 `mcp__[serverName]_[toolName]` 格式引用：

```
服务器名：filesystem
工具名：  read_file
引用名：  mcp__filesystem_read_file
```

在对话中直接使用 `mcp__filesystem_read_file` 即可调用该工具。

## 实时事件监听

服务器状态变化时会触发 `mcp:server:status` 事件：

```javascript
sema.on('mcp:server:status', (info) => {
  console.log(`MCP [${info.config.name}] 状态变化 → ${info.connectStatus}`)
  
  if (info.connectStatus === 'connected') {
    console.log(`  连接成功，可用工具：${info.capabilities?.tools?.length ?? 0}`)
  } else if (info.connectStatus === 'error') {
    console.log(`  连接错误：${info.error}`)
  }
})
```

## 配置文件示例

### 用户级配置（~/.sema/.mcp.json）

```json
{
  "mcpServers": {
    "sequential-thinking": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"]
    },
    "time": {
      "transport": "stdio",
      "command": "uvx",
      "args": ["mcp-server-time"]
    }
  }
}
```

### 项目级配置（<project>/.sema/.mcp.json）

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "remote-api": {
      "transport": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      }
    }
  }
}
```

### 项目级设置（<project>/.sema/settings.json）

```json
{
  "disabledMcpServers": ["time"],
  "enabledMcpServerUseTools": {
    "filesystem": ["read_file", "write_file", "list_directory"]
  }
}
```
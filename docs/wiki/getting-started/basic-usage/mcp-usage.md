# MCP 使用

MCP（Model Context Protocol）是一种标准协议，允许为 AI 扩展自定义工具能力。通过 MCP，任何外部服务都能以标准化方式为 Sema 提供工具。

<figure align="center">
  <img src="images/mcp.png" alt="model-list">
  <figcaption>Sema Code vscode插件页面截图</figcaption>
</figure>

## MCPServerConfig 接口

```javascript
interface MCPServerConfig {
  name: string                          // 服务器唯一名称
  description?: string                   // 服务描述
  transport: 'stdio' | 'sse' | 'http'   // 传输方式
  command?: string                      // stdio 模式：可执行文件路径
  args?: string[]                       // 命令行参数
  env?: Record<string, string>          // 环境变量
  url?: string                          // sse/http 模式：服务地址
  headers?: Record<string, string>      // HTTP 请求头
  useTools?: string[] | null            // 过滤工具列表，null 表示所有
  enabled?: boolean                     // 是否启用，默认 true
}
```


## 作用域

MCP 配置支持两种作用域：

| 作用域 | 说明 | 配置文件 |
|--------|------|---------|
| `'user'` | 全局级别，对所有项目生效 | `~/.sema/mcp-config.json` |
| `'project'` | 项目级别，仅对当前项目生效 | `.sema/mcp-config.json` |


## 添加 MCP 服务器

### stdio 模式（本地子进程，推荐）

```javascript
// npx node.js环境执行
const serverInfo = await sema.addOrUpdateMCPServer(
  {
    name: 'sequential-thinking',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  'user' // 全局作用域
)

// uvx python环境执行
// const serverInfo = await sema.addOrUpdateMCPServer(
//   {
//     name: 'time',
//     transport: 'stdio',
//     command: 'uvx',
//     args: ['mcp-server-time'],
//   },
//   'project' // 项目作用域
// )

console.log('服务器状态:', serverInfo.status)
console.log('可用工具:', serverInfo.tools.map(t => t.name))
```


## 管理 MCP 服务器

### 移除服务器

```javascript
await sema.removeMCPServer('sequential-thinking', 'user')
```

### 重新连接

```javascript
const info = await sema.connectMCPServer('filesystem')
console.log('重新连接后状态:', info.status)
```

### 过滤工具

只允许使用服务器中的部分工具：

```javascript
// 只使用 read_file 和 write_file 两个工具
sema.updateMCPUseTools('filesystem', ['read_file', 'write_file'])
```

### 查看所有 MCP 配置

```javascript
const configs = sema.getMCPServerConfigs()
// Map<'user' | 'project', MCPServerInfo[]>

for (const [scope, servers] of configs) {
  console.log(`${scope} 作用域:`)
  servers.forEach(s => console.log(`  - ${s.config.name}: ${s.status}`))
}
```


## 工具命名规则

MCP 工具在 Sema 中以 `mcp__[serverName]_[toolName]` 格式引用：

```
服务器名: filesystem
工具名:   read_file
引用名:   mcp__filesystem_read_file
```

`mcp__[serverName]_[toolName]` 就是调用llm时的tool name

## 配置文件格式

`~/.sema/mcp-config.json`（全局）或 `.sema/mcp-config.json`（项目）：

```json
{
  "mcpServers": {
    "filesystem": {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "enabled": true
    }
  }
}
```

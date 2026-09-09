# sema-chrome-host

Sema 浏览器控制的本机部分：原生消息宿主 `native-host.js` 与 stdio MCP 桥接进程 `bridge.js`，配合 Chrome 扩展 "Sema Browser Control" 使用。扩展负责浏览器操作，本包把它暴露成 MCP 工具 `mcp__chrome__*`。

## 用法

在 sema-core 的 `~/.sema/.mcp.json` 里注册：

```json
{
  "mcpServers": {
    "chrome": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "sema-chrome-host"]
    }
  }
}
```

桥接进程启动时会把 Chrome 原生宿主清单写到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sema.chrome.json`，包装脚本与套接字放在 `~/.sema/chrome/`。需要 Node ≥ 18、Chrome ≥ 116。

扩展安装、skill、协议与排障见仓库 `chrome/README.md` 与 `chrome/docs/protocol.md`。

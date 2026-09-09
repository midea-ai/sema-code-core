# Chrome 浏览器控制

让 Sema Agent 在用户自己的 Chrome 里打开、阅读和操作网页，同一份登录态，用户全程可见可接管。扩展以标准 MCP 工具接进 sema-core，内核不改。独立目录，**不进入 sema-core npm 包**。

## 架构

```
Chrome 扩展 (extension/)      标签页、授权、元素树、动作、截图、记录
    ↕ 原生消息通道
原生宿主 (host/native-host.js) 只转发
    ↕ ~/.sema/chrome/host.sock
桥接进程 (host/bridge.js)      stdio MCP 服务，每个宿主应用一个
    ↕ stdio MCP
sema-core                      工具名 mcp__chrome__*
```

## 发布物

- 扩展：Chrome Web Store，未列出，凭链接安装 <https://chromewebstore.google.com/detail/pjofgjgagohldpbcnkgnfjeehealejie>
- host：npm 包 `sema-chrome-host`
- skill：`.sema/skills/chrome-use/SKILL.md`

## 安装

前提：Chrome ≥ 116，Node ≥ 18，宿主应用已装好。

1. 从商店链接装扩展，图标红色 `!` 正常
2. `.sema/.mcp.json` 合并进 `~/.sema/.mcp.json`
3. `.sema/skills/chrome-use/SKILL.md` 复制到 `~/.sema/skills/chrome-use/`
4. 重启宿主应用，红 `!` 消失即连上

`.sema/` 可整体作为生态卡片安装，此时工具名前缀变为 `mcp__plugin_<插件名>_chrome__`。

## 文档

- [docs/development.md](docs/development.md)：运行、打包、发布、调试
- [docs/protocol.md](docs/protocol.md)：协议、方法、错误码

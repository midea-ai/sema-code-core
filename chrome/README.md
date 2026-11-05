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
- 扩展离线包：GitHub Release <https://github.com/midea-ai/sema-code-core/releases/download/chrome-extension/sema-browser-control.zip>，商店打不开时用
- host：npm 包 `sema-chrome-host`
- skill：`.sema/skills/chrome-use/SKILL.md`

## 安装

前提：macOS / Windows / Linux，Chrome ≥ 116，Node ≥ 18，宿主应用已装好。

1. 装扩展，图标红色 `!` 正常。两种方式任选
   - 商店：凭上面的链接安装
   - 离线包：下载 zip 解压，`chrome://extensions` 右上角打开「开发者模式」，「加载已解压的扩展程序」选解压出来的目录。解压目录不要删，升级时重新下载解压覆盖，再到扩展页点「重新加载」
2. `.sema/.mcp.json` 合并进 `~/.sema/.mcp.json`（host 版本钉死，升级时改版本号）
3. `.sema/skills/chrome-use/SKILL.md` 复制到 `~/.sema/skills/chrome-use/`
4. 重启宿主应用，红 `!` 消失即连上

商店装的扩展自动更新，离线包不会；host 与 skill 不自动更新，升级时重做第 2、3 步。`.sema/` 可整体作为 sema-core 插件安装，此时工具名前缀变为 `mcp__plugin_<插件名>_chrome__`。

## 文档

- [docs/development.md](docs/development.md)：运行、打包、发布、调试
- [docs/protocol.md](docs/protocol.md)：协议、方法、错误码

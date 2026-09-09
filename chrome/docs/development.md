# Chrome 浏览器控制：开发

## 目录结构

```
chrome/
├── .sema/                    # .mcp.json、skills/chrome-use/SKILL.md，即生态卡片插件目录布局
├── release.sh                # 产出 dist/ 下的扩展 zip 与 host tgz
├── extension/                # MV3 扩展，纯 JS 无构建
│   ├── manifest.json         # key 是商店公钥，解压加载与商店安装同一 ID
│   ├── background.js         # 后台：连原生宿主、分发方法
│   ├── content.js            # 内容脚本：元素树、正文、动作
│   ├── page.js               # 页面世界：对话框接管、console/fetch/XHR 钩子
│   ├── authorize.* popup.*   # 授权窗口、工具栏弹窗
│   └── lib/                  # protocol、native、auth、tabs、inject、capture、upload、methods
└── host/                     # npm 包 sema-chrome-host
    ├── native-host.js        # 原生宿主：stdio ↔ 套接字
    ├── bridge.js             # 桥接进程：stdio MCP ↔ 套接字
    └── lib/                  # protocol、framing、manifest、client、upload、tools
```

## 运行

根目录 `npm install` 过即可。`~/.sema/.mcp.json`：

```json
"chrome": { "transport": "stdio", "command": "node", "args": ["/绝对路径/sema-core/chrome/host/bridge.js"] }
```

扩展：`chrome://extensions` 开"开发者模式"，"加载已解压的扩展程序"选 `chrome/extension/`，先移除商店那份。改扩展点卡片刷新，改 host 重启宿主应用。

## 打包

```bash
chrome/release.sh
# extension: dist/sema-browser-control-<版本>.zip   商店格式，manifest 在根、去 key
# host:      dist/sema-chrome-host-<版本>.tgz
```

用 tgz 本地验证时 `.mcp.json` 写：

```json
"args": ["-y", "-p", "/绝对路径/dist/sema-chrome-host-<版本>.tgz", "sema-chrome-host"]
```

## 发布

```bash
# 扩展：① 改 extension/manifest.json 的 version（商店要求递增） ② 打包
chrome/release.sh
# ③ 后台 https://chrome.google.com/webstore/devconsole → 套件 → 上传 zip → 提交审查

# host：① 改 host/package.json 的 version ② 发布
cd chrome/host && npm publish
```

两边独立发。加了新工具时先发扩展，审核通过后再发 host，否则审核期间新工具返回 `[unsupported]`。

## 调试

- 红色 `!`：没连上原生宿主，弹窗看原因；`[not_connected]` 看 `~/.sema/chrome/host.sock` 与清单
- 橙色"停"：点过"立即停止"，弹窗"允许继续"或重启宿主应用解除
- 后台日志：扩展卡片点"Service Worker"；原生宿主日志 `~/.sema/chrome/native-host.log`
- 动作没生效：看回执的 `navigated` 与 `dialog`
- 缺加载期 console / network：钩子装晚了，reload 再读

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 原生宿主清单 | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sema.chrome.json` |
| 包装脚本、套接字、日志 | `~/.sema/chrome/` |
| host 包（npx） | `~/.npm/_npx/<hash>/node_modules/sema-chrome-host/` |
| 授权与标签状态 | `chrome.storage.local` 键 `siteAuth`；`chrome.storage.session` 键 `siteAuthSession`、`agentTabs`、`controlledTabs`、`stopped` |

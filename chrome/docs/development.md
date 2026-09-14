# Chrome 浏览器控制：开发

## 目录结构

```
chrome/
├── .sema/                    # .mcp.json、skills/chrome-use/SKILL.md，可整体作为 sema-core 插件安装
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

## 本地开发

```json
{
    "chrome": {
        "transport": "stdio",
        "command": "node",
        "args": [
            "$PWD/chrome/host/bridge.js"
        ]
    }
}
```

浏览器扩展：`chrome://extensions` ，先移除商店那份，"加载已解压的扩展程序"选当前项目的 `chrome/extension/`

## 发布

### chrome extension

```bash
# 打包
chrome/release.sh

# 在页面上传
open https://chrome.google.com/webstore/devconsole
```

### sema-chrome-host npm

```bash
cd chrome/host

# 发布
npm publish
```

发完把 `chrome/.sema/.mcp.json` 与 `chrome/host/README.md` 里的 `sema-chrome-host@<版本>` 改成新版本。

约束：
- 两边独立发。加新工具先发扩展，审核通过再发 host，否则审核期间新工具返回 `[unsupported]`。
- 扩展必须兼容旧 host。商店把新扩展推给所有人，用户的 host 钉在安装时的版本，只加方法、加字段，不改已有语义。

## 从零验证

1、清理 mcp、skill、原生宿主清单、npx 缓存

```bash
node -e "const f=process.env.HOME+'/.sema/.mcp.json',fs=require('fs');if(fs.existsSync(f)){const c=JSON.parse(fs.readFileSync(f,'utf8'));delete (c.mcpServers||{}).chrome;fs.writeFileSync(f,JSON.stringify(c,null,2)+'\n')}"
rm -rf ~/.sema/skills/chrome-use ~/.sema/chrome
rm -f ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.sema.chrome.json
grep -l '"sema-chrome-host' ~/.npm/_npx/*/package.json 2>/dev/null | xargs -n1 dirname | xargs rm -rf
```

2、`chrome://extensions` 移除已装的 Sema Browser Control

3、重新安装：扩展 + skill + mcp

扩展 Chrome Web Store 凭链接安装 <https://chromewebstore.google.com/detail/pjofgjgagohldpbcnkgnfjeehealejie>

```bash
mkdir -p ~/.sema/skills && cp -R chrome/.sema/skills/chrome-use ~/.sema/skills/
cat chrome/.sema/.mcp.json  # 只打印，需要手动安装至mcp
```

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 原生宿主清单 | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sema.chrome.json` |
| 包装脚本、套接字、日志 | `~/.sema/chrome/` |
| host 包（npx） | `~/.npm/_npx/<hash>/node_modules/sema-chrome-host/` |
| 授权与标签状态 | `chrome.storage.local` 键 `siteBlock`、`siteAsk`、`siteAuth`；`chrome.storage.session` 键 `siteAuthSession`、`agentTabs`、`controlledTabs`、`stopped` |

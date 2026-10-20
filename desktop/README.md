# SemaWork 桌面版

Electron 壳：主进程在进程内运行 webui 的服务端（随机端口、每次启动随机 token），窗口加载同一套 `webui/client` 页面。独立目录，**不进入 sema-core npm 包**；`webui/` 的网页模式（`npm start`）照常可用。

## 架构

```
Electron 主进程 (src/main.ts)
    ├─ dist/server.js（esbuild 直接从 webui/server/src 打出）.startServer()   同进程起 HTTP + WS
    │     └─ fork dist/worker-entry.js ×N                                    core 子进程，依赖 desktop/node_modules 里的 sema-core
    │     └─ dist/resources（拷自 webui/resources）生态市场资源；dist/resources/chrome（拷自 chrome/.sema）浏览器控制 skill 与 MCP
    └─ BrowserWindow → http://127.0.0.1:<随机端口>/?token=…                  页面来自 dist/public（拷自 webui/client/dist）
        ↕ preload 暴露 window.sema.desktop（platform / electron 标记，setBadgeCount 未看会话数 → Dock 角标）
```

运行时依赖（sema-core、node-pty、ws 等）全部在 `desktop/package.json` 声明，sema-core 用 npm 已发布版本，不依赖仓库根目录的构建。

## 本地运行

前提：Node ≥ 20.18.1，`webui/` 已构建（只需要 client 产物）。

```bash
cd webui && npm run build && cd ..
cd desktop
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   # 下载慢时用
npm install
npm run dev
```

改了 `webui/` 代码：

```bash
cd webui && npm run build && cd ..  
cd desktop && npm run dev
```

## 打包

```bash
npm run pack            # 最快：只出 release/mac-arm64/SemaWork.app，不压 dmg，自测用
npm run dist:mac:arm64  # 只打 Apple Silicon 的 dmg
npm run dist:mac        # release/SemaWork-<版本>-mac-arm64.dmg 与 SemaWork-<版本>-mac-x64.dmg，只能在 macOS 上打
npm run dist:win        # release/SemaWork-<版本>-win-x64.exe，macOS 上也能打
npm run dist:linux      # release/SemaWork-<版本>-linux-amd64.deb，macOS 上也能打
npm run notarize        # 对 release/ 下已签名的 SemaWork.app 做 Apple 公证并重新压 dmg，可加 arm64 / x64 只处理一个架构
```

安装包统一命名为 `SemaWork-<版本>-<平台>-<架构>.<扩展名>`，由 `electron-builder.yml` 顶层的 `artifactName` 控制。

macOS 签名与公证：钥匙串里有 Developer ID Application 证书时 `dist:mac` 自动正式签名，没有证书时做 ad-hoc 签名。公证不在打包里做，打完包在网络通畅时单独 `npm run notarize`，需要环境变量 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。

未签名 / 未公证的包，体验者首次打开：

- macOS：提示「无法验证开发者」时到系统设置 → 隐私与安全性 → 仍要打开；或先执行 `xattr -cr /Applications/SemaWork.app`
- Windows：SmartScreen 拦截时点「更多信息」→「仍要运行」
- Linux：deb 经 apt 安装后直接从应用列表启动，无额外步骤

数据与网页模式共用 `~/.sema/`，安装包不带模型配置，首次打开需在设置里配模型。

## 备注

- 首次打包要下载对应架构的 Electron 二进制并缓存到 `~/Library/Caches/electron`，之后不再下载；压 dmg 每个架构约一两分钟。
- 公证上传 Apple 走 AWS S3，国内直连常传不上去，放在打包里会卡死打包，所以单独跑；notarytool 不读 `https_proxy`，传不上去时换手机热点或系统代理。
- ad-hoc 签名由 `scripts/afterPack.js` 做，Apple Silicon 拒绝运行完全没有签名的二进制；钥匙串里有证书时跳过，交给 electron-builder 正式签名（hardened runtime）。
- ripgrep 随包分发：`scripts/afterPack.js` 按目标平台与架构取 `@vscode/ripgrep-<平台>-<架构>` 子包（打包机已装的直接用，其余经 `npm pack` 从 npm registry 拉取，缓存在 `node_modules/.cache/semawork-ripgrep`），放到产物的 `node_modules/@vscode/ripgrep/bin/rg(.exe)`，即 sema-core 查找内置 rg 的位置。用户机器 PATH 里有 rg 时优先用系统的。
- macOS 上打 deb 需要 GNU tar：electron-builder 自带的 linux-tools gtar 按 macOS 26 编译，macOS 15 及更早系统上跑不起来（日志 `fpm process failed` / `tar failed` / `Abort trap: 6 gtar`）。打包机做一次即可：

  ```bash
  brew install gnu-tar
  ln -sf /opt/homebrew/bin/gtar ~/Library/Caches/electron-builder/linux-tools-mac@*/*/bin/gtar
  ```

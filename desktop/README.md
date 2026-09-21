# SemaWork 桌面版

Electron 壳：主进程在进程内运行 webui 的服务端（随机端口、每次启动随机 token），窗口加载同一套 `webui/client` 页面。独立目录，**不进入 sema-core npm 包**；`webui/` 的网页模式（`npm start`）照常可用。

## 架构

```
Electron 主进程 (src/main.ts)
    ├─ dist/server.js（esbuild 直接从 webui/server/src 打出）.startServer()   同进程起 HTTP + WS
    │     └─ fork dist/worker-entry.js ×N                                    core 子进程，依赖 desktop/node_modules 里的 sema-core
    │     └─ dist/resources（拷自 webui/resources）生态市场资源；dist/resources/chrome（拷自 chrome/.sema）浏览器控制 skill 与 MCP
    └─ BrowserWindow → http://127.0.0.1:<随机端口>/?token=…                  页面来自 dist/public（拷自 webui/client/dist）
        ↕ preload 暴露 window.sema.desktop
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

改了 core 代码：

```bash
npm run build && npm pack 
cd desktop
npm install ../sema-core-<版本>.tgz --no-save   # 不改 package.json 与 lock
npm run dev
```

测完在 `desktop/` 执行 `rm -rf node_modules/sema-core && npm install` 还原为发布版。

## 打包

```bash
npm run pack            # 最快：只出 release/mac-arm64/SemaWork.app，不压 dmg，自测用
npm run dist:mac:arm64  # 只打 Apple Silicon 的 dmg
npm run dist:mac        # release/SemaWork-<版本>-mac-arm64.dmg 与 SemaWork-<版本>-mac-x64.dmg，只能在 macOS 上打
npm run dist:win        # release/SemaWork-<版本>-win-x64.exe，macOS 上也能打
npm run dist:linux      # release/SemaWork-<版本>-linux-x86_64.AppImage
```

安装包统一命名为 `SemaWork-<版本>-<平台>-<架构>.<扩展名>`，由 `electron-builder.yml` 顶层的 `artifactName` 控制。

首次打包要下载对应架构的 Electron 二进制并缓存到 `~/Library/Caches/electron`，之后不再下载；压 dmg 每个架构约一两分钟。

ripgrep 随包分发：`scripts/afterPack.js` 按目标平台与架构取 `@vscode/ripgrep-<平台>-<架构>` 子包（打包机已装的直接用，其余经 `npm pack` 从 npm registry 拉取，缓存在 `node_modules/.cache/semawork-ripgrep`），把二进制放到产物的 `node_modules/@vscode/ripgrep/bin/rg(.exe)`，即 sema-core 查找内置 rg 的位置。用户机器 PATH 里有 rg 时优先用系统的。

未签名，体验者首次打开：

- macOS：提示「无法验证开发者」时到系统设置 → 隐私与安全性 → 仍要打开；或先执行 `xattr -cr /Applications/SemaWork.app`
- Windows：SmartScreen 拦截时点「更多信息」→「仍要运行」
- Linux：`chmod +x SemaWork-*.AppImage` 后直接运行

数据与网页模式共用 `~/.sema/`，安装包不带模型配置，首次打开需在设置里配模型。

## 当前范围

- 双击运行、单实例、关窗口 macOS 隐藏（Dock 点击恢复）、退出前优雅关闭 worker 与终端
- GUI 启动时从登录 shell 继承 PATH，Agent 才能找到 git / node
- 不签名、无托盘、无自动更新；原生对话框 / 通知 / 拖拽路径等留待后续

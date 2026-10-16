# SemaWork

## 项目概述

**SemaWork** 是随本仓库提供的本地 Web 界面（位于 [`webui/`](https://github.com/midea-ai/sema-code-core/tree/main/webui) 目录）：在浏览器里与 Agent 对话，驱动其对本地目录读写文件、执行命令，并可视化展示整个过程。

<img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/webui.gif" alt="SemaWork" />

## 功能亮点

- **对话与工具可视化** — 流式回复、工具调用卡片、权限应答、待办列表
- **代码审阅** — 查看会话中的文件改动 diff
- **右侧面板** — 终端、内嵌浏览器、文件预览多标签并存
- **任务面板** — 定时任务管理、快问旁路问答、子代理运行详情
- **项目 / 会话管理** — 项目与独立会话两级组织，支持分支到新聊天、刷新与断线恢复

## 启动方式

- **npm 包** `sema-code-ui`：`npm i -g sema-code-ui` 后运行 `sema-ui` 一条命令启动并打开浏览器，`status` / `open` / `stop` 子命令管理实例
- **源码运行**：构建 `webui/` 后 `npm start`
- **桌面版**：`desktop/` 目录基于 Electron 打包，与网页版同源

命令与参数见[快速开始 · 方式一](wiki/getting-started/quick-start)。

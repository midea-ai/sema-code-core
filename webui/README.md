# semawork

基于 sema-core 的本地 Web 界面：在浏览器里用自然语言驱动 Agent 对本地目录读写文件、执行命令，可视化展示流式回复、工具调用、权限应答、文件改动、待办、子代理，并支持项目 / 会话管理与刷新恢复。独立 workspace，**不进入 sema-core npm 包**。

产品需求与开发计划见 [doc/](./doc/)。

## 架构

```
浏览器 (client, React SPA)
    ↕ REST（项目/会话/配置 CRUD、会话快照）+ WebSocket（会话动作 + 事件流，带 seq；/ws/term 终端数据通道）
server (Node 主进程，127.0.0.1 + 持久化 token)
    ├─ registry    项目/会话索引  ~/.sema/webui/index.json，目录 ~/Documents/Sema/...
    ├─ terminal    node-pty 终端进程池（右侧栏终端窗口，cwd=会话目录）
    ├─ sessions    会话快照 + 事件缓冲（刷新/断线补发），落盘 ~/.sema/webui/transcripts/
    └─ workers     按 workingDir fork core 子进程池（常驻、空闲回收）
        ↕ child_process IPC
core worker ×N（每个目录一个 new SemaCore({ workingDir })）
```

## 目录结构

```
webui/
├── package.json          # workspaces: server, client
├── doc/                  # 产品需求 / 开发计划
├── shared/               # 服务端与前端共用：协议常量、快照/消息块类型、事件→消息块 reducer
├── server/
│   ├── esbuild.mjs       # 打包 dist/index.js（服务端）与 dist/worker-entry.js（core 子进程）
│   └── src/
│       ├── index.ts      # 入口：参数、token、HTTP 静态托管、WS 升级
│       ├── sessions.ts   # SessionManager：快照 / 订阅 / 动作分发 / worker 存活
│       ├── workers/      # pool.ts 子进程池；entry.ts 子进程入口（SemaCore + 会话事件转发）
│       ├── registry/     # 注册表与设置（原子写入）
│       ├── http/         # REST 路由、打开目录 / 系统浏览器 / 废纸篓
│       └── ws/           # WebSocket 请求应答与事件推送
└── client/
    └── src/
        ├── app/          # 三栏布局
        ├── features/     # sidebar（项目/会话树）、chat（消息流/卡片/输入框）、panel（右侧浏览器标签）、settings（模型/系统配置）
        ├── store/        # zustand：应用状态、会话快照（复用 shared reducer）
        ├── api/          # REST / WebSocket 客户端
        ├── common/       # UI 原语（按钮、弹层、对话框等）
        └── i18n/         # 文案字典
```

## 构建与运行

要求 Node ≥ 20.18.1，并已构建仓库根目录的 sema-core（`npm run build`，server 通过 `file:../..` 依赖）。

首次：

```bash
cd webui
npm install
npm run build && node server/dist/index.js --open      # 构建并启动，自动打开浏览器
```

修改代码后（Ctrl+C 停掉旧服务再执行；不加 `--open`，已打开的页面会自动重连，加了会多开一个标签）：

```bash
npm run build && node server/dist/index.js             # 重新构建并启动（改了根目录 sema-core 需先在根目录 npm run build）
```

参数：`--port 3210` 改端口；`--token xxx` 指定 token。token 首次随机生成后保存在 `~/.sema/webui/token`，重启复用，已打开的页面会自动重连，不用重新打开链接。仅监听 loopback，非 loopback `--host` 会拒绝启动。

渲染预览：把 `client/src/preview/mockBlocks.ts` 的 `PREVIEW_COMPONENTS` 设为 `null`（全部）或指定 key 列表，侧栏「会话」下会出现「🧪 渲染预览」本地 mock 会话（不经服务端，其他会话照常使用）；设回 `[]` 关闭。预览相关代码全部在 `client/src/preview/`。

## 数据位置

| 内容 | 位置 |
| --- | --- |
| 系统配置（工具搜索、后台任务、权限开关、自定义规则、默认档位） | `~/.sema/webui/settings.json` |
| 项目 / 会话索引（名称、目录、创建/活跃时间、模式、档位） | `~/.sema/webui/index.json` |
| 访问 token（重启复用） | `~/.sema/webui/token` |
| 会话页面消息流快照（用户/AI 文本、工具卡片、权限应答、文件改动等，用于刷新/重启恢复） | `~/.sema/webui/transcripts/<sessionId>.json` |
| 进程级 core 的工作目录（模型/系统配置等全局操作专用） | `~/.sema/webui/workspace/` |
| 右侧浏览器标签、当前视图 | 浏览器 `localStorage`（仅 UI 状态） |
| 项目目录 | `~/Documents/Sema/<项目名>/`（导入目录只记录路径） |
| 独立会话目录 | `~/Documents/Sema/<YYYY-MM-DD>/<sessionId>/` |
| 模型列表 / API Key、MCP、Skills 等全局配置，以及给模型看的对话历史 | `~/.sema/`（由 core 管理，历史在 `~/.sema/history/<目录名>/`，WebUI 仅在退场时经 core 接口清理） |

## 上限与退场

超出上限按 lastActiveAt LRU 自动退场（新建会话/项目时触发；忙碌中或前端正打开的会话不淘汰）：

| 对象 | 上限 | 退场动作 |
| --- | --- | --- |
| 独立会话 | 50 | 移除索引/快照，硬删 `~/Documents/Sema/<日期>/<会话id>/`，并删 core 对应 history 项目 |
| 项目内会话 | 每项目 50 | 移除索引/快照，删 core 该会话历史文件（项目目录不动） |
| 项目 | 30 | 仅移除索引（磁盘目录与 core history 保留，重新导入可恢复） |

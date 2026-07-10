# 项目概述

## 简介

**Sema Core**（`sema-core`）是一个**事件驱动型 AI 编程助手核心引擎**。它是一个可复用的 TypeScript 库，旨在作为 AI 编码工具（如 IDE 插件、CLI 工具或自定义编程自动化工作流）的智能核心层。

引擎负责 LLM 编排、多 Agent 协调、工具执行、权限控制、会话管理、插件/Skill/MCP 扩展加载与后台任务调度，使用方只需关注 UI/UX 层。

>  主要应用场景：驱动 [Sema Code Extension](https://github.com/midea-ai/sema-code-vscode-extension)（VSCode 插件 / JetBrains 插件）等 AI 编程工具。

## 技术栈

| 类别 | 技术 |
|---|---|
| 语言 | TypeScript 5.x（编译为 CommonJS ES2021） |
| LLM SDK | `@anthropic-ai/sdk`、`openai` |
| MCP 协议 | `@modelcontextprotocol/sdk` |
| 文件搜索 | `@vscode/ripgrep`、`glob` |
| Schema 校验 | `zod`、`zod-to-json-schema` |
| 事件系统 | 自定义 EventBus（进程内单例，支持 `sessionId` 路由） |
| 构建工具 | `tsc`（纯 TypeScript 编译，无打包器） |
| 运行时 | Node.js >= 16.0.0 |

## 目录结构

```
sema-core/
├── src/                        # TypeScript 源码
│   ├── index.ts                # 公共入口：导出 SemaCore / SemaSession
│   ├── conf/                   # 配置常量定义
│   │   ├── config.ts           # 默认路径、保留数等配置常量
│   │   └── define.ts           # 类型定义
│   ├── core/                   # 核心引擎层
│   │   ├── SemaCore.ts         # 进程级 API 门面类
│   │   ├── SemaSession.ts      # 会话级 API
│   │   ├── SessionPool.ts      # 多会话池
│   │   ├── SemaEngine.ts       # 单会话业务逻辑引擎
│   │   ├── Conversation.ts     # 递归 LLM 查询/工具调用循环（异步生成器）
│   │   └── RunTools.ts         # 工具执行：串行 & 并发策略
│   ├── events/                 # 事件系统
│   │   ├── EventSystem.ts      # 事件总线（单例）
│   │   └── types.ts            # 事件类型定义
│   ├── manager/                # 单例管理器层
│   │   ├── ConfManager.ts      # 核心 & 项目配置管理
│   │   ├── ModelManager.ts     # LLM 模型配置管理（CRUD + 文件持久化）
│   │   ├── PermissionManager.ts# 工具权限检查 & 提示
│   │   ├── StateManager.ts     # 会话状态、消息历史、待办（按 Agent 隔离）
│   │   ├── TaskManager.ts      # 后台任务（RunShell/SubAgent）管理与转后台
│   │   └── CronManager.ts      # 定时任务管理
│   ├── services/               # 领域服务
│   │   ├── agents/             # 子 Agent 系统：AgentsManager、提示词、内置配置
│   │   ├── api/                # LLM API 层（queryLLM、Anthropic/OpenAI 适配器、缓存）
│   │   │   ├── adapt/          # 适配器：anthropic.ts、openai.ts
│   │   │   ├── queryLLM.ts
│   │   │   ├── cache.ts
│   │   │   └── apiUtil.ts      # API 工具函数
│   │   ├── commands/           # 系统命令 & 自定义命令分发
│   │   ├── design/             # 设计资源管理
│   │   ├── mcp/                # MCP 协议：MCPClient、MCPManager、MCPToolAdapter
│   │   ├── memory/             # Memory 记忆文件加载与管理
│   │   ├── plugins/            # 插件 & 插件市场（marketplace）管理
│   │   ├── rules/              # 项目规则（rules）加载与管理
│   │   └── skills/             # Skill 加载器、解析器、注册表
│   ├── tools/                  # 内置 AI 工具（21 个）
│   │   ├── base/               # 工具基类：Tool.ts、tools.ts
│   │   └── [21 个工具文件]
│   ├── prompt/                 # 提示词
│   ├── types/                  # TypeScript 类型定义
│   └── util/                   # 工具模块
├── dist/                       # 编译输出（CommonJS）
├── tests/                      # 测试脚本
├── docs/                       # Docsify 文档站点
├── package.json
└── tsconfig.json
```

## 核心模块

### Core 层（`src/core/`）

| 模块 | 职责 |
|---|---|
| **SemaCore** | 进程级入口门面，对外暴露：会话池（`createSession`/`getSession`/`listSessions`/`closeSession`）、进程级事件订阅（`cron:update`/`mcp:server:status`），以及模型、配置、MCP、Skill、Agent、Command、Memory、Rule、Design、插件市场等全局管理 API |
| **SemaSession** | 会话级入口。处理用户输入、中断、会话级事件订阅、权限/表单/Plan 响应、Agent 模式切换和后台任务管理 |
| **SessionPool** | 管理多个 `SemaSession` 的创建、复用、查找、活跃会话设置和关闭 |
| **SemaEngine** | 单会话业务逻辑引擎。绑定固定 `sessionId`，维护该会话输入队列，处理用户输入并调用 `query()` 运行主循环；管理 `AbortController` 实现可中断；注入该会话的 `TaskManager` 和 `CronManager` 通知回调 |
| **Conversation** | 异步生成器实现递归 LLM Agentic 循环：调用 LLM → 解析工具调用 → 执行工具 → 递归调用自身，支持 Agent/Plan 模式切换时重建上下文，支持上下文自动压缩（compact） |
| **RunTools** | 工具执行策略：当本轮所有工具都 `isSafe()` 或 `canRunConcurrently()` 时整批并发，否则整批串行；包含 Zod schema 校验、输入验证、权限检查、异步生成器流式输出 |

### Manager 层（`src/manager/`）

| 模块 | 职责 |
|---|---|
| **StateManager** | 多会话状态注册表：`sessionId -> SessionRuntime`；会话内再按 Agent 隔离消息历史、文件读取时间戳、待办事项和状态 |
| **ConfManager** | 配置管理：维护 `SemaCoreConfig`（工作目录、日志级别、流式输出、默认 Agent 模式、`useTools`/`disabledTools`、`maxSessions`、`disableBackgroundTasks` 等），持久化项目配置到 `~/.sema/projects.conf` |
| **ModelManager** | 模型配置管理：持久化到 `~/.sema/model.conf`，支持双模型指针（`main` 主模型 + `quick` 轻量模型），CRUD 操作及任务模型应用 |
| **PermissionManager** | 分层权限系统：文件编辑（会话级）、RunShell 命令（白名单 + LLM 分析 + 项目持久化）、Skill/MCP 工具（按工具持久化） |
| **TaskManager** | 后台任务调度：管理 RunShell 与 SubAgent 后台进程，按会话限流、过滤列表、停止任务和投递完成通知 |
| **CronManager** | 定时任务管理：基于 cron 表达式调度，触发时优先投递来源会话，兜底投递 UI 活跃会话 |

### Services 层（`src/services/`）

| 模块 | 职责 |
|---|---|
| **api/** | LLM 抽象层，根据模型配置路由到 Anthropic 或 OpenAI 适配器，支持流式输出、LRU 缓存与连通性测试 |
| **mcp/** | MCP 协议集成，管理全局和项目级 MCP 服务器配置，支持 `stdio`/`sse`/`http` 传输，工具缓存与文件 mtime 失效策略 |
| **agents/** | 子 Agent 系统，从 `.md` 文件加载 Agent 配置（用户级 `~/.sema/agents/` + 项目级 `.sema/agents/`），支持内置 + 自定义 Agent，并提供 `genSystemPrompt`、systemReminder 注入 |
| **skills/** | Skill 插件系统，基于带 YAML frontmatter 的 Markdown 文件，项目级覆盖用户级 |
| **commands/** | 系统命令（`/clear`、`/compact`、`/quickchat` 等）和自定义命令分发 |
| **design/** | 设计资源管理，加载 Design Skill 与 Design System 信息 |
| **plugins/** | 插件与插件市场（marketplace）管理：从 git 仓库或本地目录添加、安装、启用、更新、卸载插件 |
| **memory/** | 记忆文件加载与刷新，参与系统提示词构建 |
| **rules/** | 项目规则文件加载与刷新，参与系统提示词构建 |

### 工具系统（`src/tools/`）

21 个内置工具，统一实现 `Tool<TInput, TOutput>` 接口：

| 工具 | 用途 |
|---|---|
| RunShell | 终端命令执行（支持 `background` 后台任务） |
| SearchFiles / SearchContent | 文件 / 文本搜索 |
| ViewFile / WriteFile / PatchFile | 文件读取、写入、补丁编辑 |
| EditNotebook | Jupyter Notebook 编辑 |
| CreateTodo / GetTodo / UpdateTodo / ListTodos | 任务规划 / 待办管理 |
| CreateCron / DelCron / ListCrons | 定时任务管理 |
| FetchUrl | 网页内容抓取 |
| Skill | 调用 Skill 插件 |
| SubAgent | 启动子 Agent（支持后台运行） |
| PeekBgJob | 查看后台任务输出 |
| StopBgJob | 停止后台任务 |
| AskForm | 向用户展示结构化表单 |
| PlanToAgent | 退出 Plan 模式 |

## 架构模式

- **门面模式** — `SemaCore` 作为进程级门面，`SemaSession` 作为会话级门面
- **单例模式** — EventBus、StateManager、ConfManager、ModelManager、PermissionManager、TaskManager、CronManager、MCPManager、AgentsManager、SkillsManager、CommandsManager、PluginsManager、MemoryManager、RuleManager、DesignManager 均通过 `getXxx()` / `getInstance()` 访问
- **事件驱动架构** — 会话级事件通过 `sessionId` 路由，进程级事件通过全局监听器订阅，完全解耦核心引擎与 UI/宿主逻辑
- **异步生成器模式** — `Conversation.query()`、`RunTools.runToolsSerially()`、`tool.call()` 均使用 `AsyncGenerator` 实现增量流式输出
- **递归 Agentic 循环** — `query()` 在每轮工具调用后递归调用自身，实现标准 ReAct/tool-use 模式
- **可插拔工具** — 内置工具和 MCP 工具统一实现 `Tool<TInput, TOutput>` 接口
- **优先级覆盖** — Agent、Skill、Command、MCP 配置遵循：项目级 > 用户级 > 内置默认
- **多会话池** — `SessionPool` 支持多个 `SemaSession` 并存，创建新会话不会自动中断旧会话
- **输入队列** — 处理中收到的用户输入会按 `command` / `inject` 类型进入当前会话队列，处理结束后由 `processQuery` 的 finally 自动消费

## 事件系统

EventBus 是全局单例发布/订阅系统，所有模块间通信通过事件总线完成：

| 分类 | 关键事件 |
|---|---|
| 会话生命周期 | `session:ready`、`session:error`、`session:interrupted`、`session:cleared`、`state:update` |
| 用户输入 | `input:received`、`input:processing` |
| AI 消息 | `message:text:chunk`、`message:thinking:chunk`、`message:complete` |
| 工具执行 | `tool:permission:request`、`tool:permission:response`、`tool:execution:complete`、`tool:execution:chunk`、`tool:execution:error` |
| 子 Agent | `task:agent:start`、`task:agent:end` |
| 后台任务 | `task:start`、`task:end`、`task:transfer` |
| Plan 模式 | `plan:exit:request`、`plan:exit:response`、`plan:implement` |
| 提问交互 | `pick:option:request`、`pick:option:response` |
| 待办 | `todos:update` |
| 上下文 | `conversation:usage`、`compact:exec`、`file:reference`、`topic:update` |
| 旁路问答 | `quickchat:response` |
| 定时任务 | `cron:update` |
| 权限档位 | `permissionLevel:update` |
| MCP 状态 | `mcp:server:status` |

## 入口与导出

```javascript
// 库入口
import { SemaCore } from 'sema-core'

const sema = new SemaCore({ workingDir: '/path/to/project' })
const result = await sema.createSession()
if (!result.ok) throw new Error(result.error)

const session = result.session
session.on('message:text:chunk', data => process.stdout.write(data.delta))
session.processUserInput('帮我读取 README.md')
```

package.json 提供了多个导出入口：
- `.` - 主入口，导出 SemaCore / SemaSession
- `./types` - 类型定义
- `./event` - 事件类型
- `./mcp` - MCP 相关模块

## 持久化路径

| 文件 / 目录 | 用途 |
|---|---|
| `~/.sema/model.conf` | 模型配置 |
| `~/.sema/projects.conf` | 项目级配置（含输入历史、`allowedTools` 等） |
| `~/.sema/history/<project>/` | 会话消息历史（按项目目录隔离） |
| `~/.sema/logs/` | 服务日志 |
| `~/.sema/llm_logs/` | LLM 调用日志 |
| `~/.sema/tracks/` | LLM 调用轨迹归档 |
| `~/.sema/event/` | 事件日志 |
| `~/.sema/cache/llm-cache.json` | LLM LRU 缓存 |

> Sema 根目录可通过环境变量 `SEMA_ROOT` 自定义。

## 构建与开发

| 命令 | 说明 |
|---|---|
| `npm install` | 安装依赖 |
| `npm run build` | 编译 TypeScript 到 `dist/`（通过 `tsc`） |

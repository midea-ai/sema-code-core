# 项目概述

## 简介

**Sema Code Core**（`sema-core`）是一个**事件驱动型 AI 编程助手核心引擎**。它是一个可复用的 TypeScript 库，旨在作为 AI 编码工具（如 IDE 插件、CLI 工具或自定义编程自动化工作流）的智能核心层。

引擎负责 LLM 编排、多 Agent 协调、工具执行、权限控制和会话管理，使用方只需关注 UI/UX 层。

>  主要应用场景：驱动 [Sema Code VSCode Extension](https://github.com/midea-ai/sema-code-vscode-extension) 等 AI 编程工具。

## 技术栈

| 类别 | 技术 |
|---|---|
| 语言 | TypeScript 5.x（编译为 CommonJS ES2021） |
| LLM SDK | `@anthropic-ai/sdk`、`openai` |
| MCP 协议 | `@modelcontextprotocol/sdk` |
| 文件搜索 | `@vscode/ripgrep`、`glob` |
| Schema 校验 | `zod`、`zod-to-json-schema` |
| 事件系统 | 自定义 EventEmitter / EventBus（基于 Node.js `events`） |
| 构建工具 | `tsc`（纯 TypeScript 编译，无打包器） |
| 运行时 | Node.js >= 16.0.0 |

## 目录结构

```
sema-code-core/
├── src/                        # TypeScript 源码
│   ├── index.ts                # 公共入口：导出 SemaCore
│   ├── core/                   # 核心引擎层
│   │   ├── SemaCore.ts         # 对外 API 门面类
│   │   ├── SemaEngine.ts       # 内部业务逻辑引擎
│   │   ├── Conversation.ts     # 递归 LLM 查询/工具调用循环（异步生成器）
│   │   └── RunTools.ts         # 工具执行：串行 & 并发策略
│   ├── events/                 # 事件系统
│   ├── manager/                # 单例管理器层
│   │   ├── ConfManager.ts      # 核心 & 项目配置管理
│   │   ├── ModelManager.ts     # LLM 模型配置管理（CRUD + 文件持久化）
│   │   ├── PermissionManager.ts# 工具权限检查 & 提示
│   │   └── StateManager.ts     # 会话状态、消息历史、待办（按 Agent 隔离）
│   ├── services/               # 领域服务
│   │   ├── agents/             # 多 Agent：AgentsManager、提示词、内置配置
│   │   ├── api/                # LLM API 层（queryLLM、Anthropic/OpenAI 适配器、缓存）
│   │   ├── command/            # 系统 & 自定义命令处理
│   │   ├── mcp/                # MCP 协议：MCPClient、MCPManager、MCPToolAdapter
│   │   ├── plugins/            # 自定义命令加载
│   │   └── skill/              # Skill 加载器、解析器、注册表
│   ├── tools/                  # 内置 AI 工具（12 个）
│   ├── types/                  # TypeScript 类型定义
│   └── util/                   # ~30 个工具模块
├── dist/                       # 编译输出（CommonJS）
├── test/                       # 测试脚本
├── docs/                       # Docsify 文档站点
├── package.json
└── tsconfig.json
```

## 核心模块

### Core 层（`src/core/`）

| 模块 | 职责 |
|---|---|
| **SemaCore** | 公共入口，对外暴露会话管理（`createSession`/`processUserInput`/`interruptSession`）、事件订阅（`on`/`once`/`off`）、响应方法（`respondToToolPermission` 等）及模型、配置、MCP、Skill、Agent 管理 API |
| **SemaEngine** | 核心业务逻辑引擎。初始化会话，处理用户输入，通过 `Conversation.query()` 运行主查询循环，管理 AbortController 实现中断 |
| **Conversation** | 异步生成器实现递归 LLM Agentic 循环：调用 LLM → 解析工具调用 → 执行工具 → 递归调用自身，支持 Agent/Plan 模式切换时重建上下文 |
| **RunTools** | 工具执行策略：只读工具（Glob/Grep/Read）并发执行，写入工具串行执行；包含 Zod schema 校验、输入验证、权限检查 |

### Manager 层（`src/manager/`）

| 模块 | 职责 |
|---|---|
| **StateManager** | 全局状态管理，按 Agent 隔离：会话状态、消息历史、文件读取时间戳、待办事项；支持历史持久化到磁盘 |
| **ConfManager** | 配置管理：存储 `SemaCoreConfig`（工作目录、日志级别、流式输出、权限等），持久化项目配置到 `~/.sema/project.json` |
| **ModelManager** | 模型配置管理：持久化到 `~/.sema/models.json`，双模型指针（`main` 主模型 + `quick` 轻量模型），CRUD 操作 |
| **PermissionManager** | 分层权限系统：文件编辑（会话级）、Bash 命令（白名单 + LLM 分析 + 项目持久化）、Skill/MCP 工具（按工具持久化） |

### Services 层（`src/services/`）

| 模块 | 职责 |
|---|---|
| **api/** | LLM 抽象层，根据模型配置路由到 Anthropic 或 OpenAI 适配器，支持流式输出和 LRU 缓存 |
| **mcp/** | MCP 协议集成，管理全局和项目级 MCP 服务器配置，支持 `stdio`/`sse`/`http` 传输，工具缓存与文件 mtime 失效策略 |
| **agents/** | 子 Agent 系统，从 `.md` 文件加载 Agent 配置（用户级 `~/.sema/agents/` + 项目级 `.sema/agents/`），支持内置 + 自定义 Agent |
| **skill/** | Skill 插件系统，基于带 YAML frontmatter 的 Markdown 文件，项目级覆盖用户级 |
| **command/** | 系统命令（`/clear`、`/compact` 等）和自定义命令分发 |

## 架构模式

- **门面模式** — `SemaCore` 作为统一 API 门面，外部使用方仅与之交互
- **单例模式** — EventBus、StateManager、ConfManager、ModelManager、MCPManager、AgentsManager 均通过 `getInstance()` 访问
- **事件驱动架构** — 所有异步操作（工具权限、流式输出、会话状态）通过 EventBus 发布/订阅，完全解耦核心引擎与 UI/宿主逻辑
- **异步生成器模式** — `Conversation.query()`、`RunTools.runToolsSerially()`、`tool.call()` 均使用 `AsyncGenerator` 实现增量流式输出
- **递归 Agentic 循环** — `query()` 在每轮工具调用后递归调用自身，实现标准 ReAct/tool-use 模式
- **可插拔工具** — 内置工具和 MCP 工具统一实现 `Tool<TInput, TOutput>` 接口
- **优先级覆盖** — Agent、Skill、MCP 配置遵循：项目级 > 用户级 > 内置默认

## 事件系统

EventBus 是全局单例发布/订阅系统，所有模块间通信通过事件总线完成：

| 分类 | 关键事件 |
|---|---|
| 会话生命周期 | `session:ready`、`session:error`、`session:interrupted`、`state:update` |
| AI 消息 | `message:text:chunk`、`message:thinking:chunk`、`message:complete` |
| 工具执行 | `tool:permission:request`、`tool:permission:response`、`tool:execution:complete` |
| 子 Agent | `task:agent:start`、`task:agent:end` |
| Plan 模式 | `plan:exit:request`、`plan:exit:response`、`plan:implement` |
| 提问交互 | `ask:question:request`、`ask:question:response` |
| 上下文 | `conversation:usage`、`compact:exec`、`file:reference`、`topic:update` |

## 入口与导出

```javascript
// 库入口
import { SemaCore } from 'sema-core'

// 类型导出
import type { SemaCoreConfig, ModelConfig, ... } from 'sema-core/types'

// 事件类型导出
import type { EventMap, ... } from 'sema-core/event'

// MCP 导出
import { MCPManager, ... } from 'sema-core/mcp'
```

## 构建与开发

| 命令 | 说明 |
|---|---|
| `npm run build` | 编译 TypeScript 到 `dist/`（通过 `tsc`） |
| `node test/miniCli.test.js` | 交互式 CLI 测试 |

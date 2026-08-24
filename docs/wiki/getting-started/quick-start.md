# 快速开始

三种方式启动 AI 编码 Agent：在浏览器里体验用 SemaWork，集成到自己的应用用 Node.js 或各语言 SDK。

## 方式一：SemaWork（浏览器体验）

SemaWork 是基于 sema-core 的本地 Web 界面。

<p align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/webui.png" alt="SemaWork"/>
</p>

```bash
# 1. 克隆并构建 sema-core
git clone https://github.com/midea-ai/sema-code-core.git
cd sema-code-core && npm install && npm run build

# 2. 构建并启动 SemaWork
cd webui && npm install && npm run build
npm start -- --open
```

浏览器打开后在「设置」添加模型与 API Key 即可对话。

## 方式二：Node.js 直接集成

```bash
mkdir my-app && cd my-app
npm init -y
npm install sema-core
```

下载 [`quickstart.mjs`](https://github.com/midea-ai/sema-code-core/tree/main/example/quickstart.mjs) 到 `my-app`，修改 `workingDir`（Agent 操作的目标仓库）和 `apiKey`，然后运行：

```bash
node quickstart.mjs
```

## 方式三：Java / Python / C# SDK

各语言 SDK 与 Node 版 API 一致。

**Java**（Maven Central，17+）：

```xml
<dependency>
  <groupId>io.github.midea-ai</groupId>
  <artifactId>sema-core</artifactId>
  <version>{版本号}</version>
</dependency>
```

**Python**（PyPI，3.10+）：

```bash
pip install sema-core
```

**C#**（NuGet，.NET 8+）：

```bash
dotnet add package Semacore
```

用法与示例见 [Java / Python / C# SDK](wiki/sdk/overview)。

## 关键概念

| 概念 | 说明 | 文档 |
|------|------|------|
| **SemaCore** | 进程级入口，管理全局资源、配置和会话池 | [SemaCore - 公共 API 层](wiki/core-concepts/core-architecture/sema-core-public-api) |
| **SemaSession** | 会话级入口，处理输入、事件、权限响应和后台任务 | [SemaSession - 会话级 API](wiki/core-concepts/core-architecture/sema-session-api) |
| **事件系统** | 流式输出、状态变化、工具执行均通过事件通知 | [事件总线架构](wiki/core-concepts/event-system/event-bus) |
| **工具权限** | 写操作默认需要用户授权 | [权限系统](wiki/core-concepts/permission-system/overview) |
| **MCP / Skill** | 扩展工具与可复用工作流 | [MCP 使用](wiki/getting-started/basic-usage/mcp-usage) · [Skill 使用](wiki/getting-started/basic-usage/skill-usage) |

## 下一步

- [模型管理](wiki/getting-started/basic-usage/add-new-model) — 配置更多 LLM 服务商
- [Command 使用](wiki/getting-started/basic-usage/command-usage) — 内置命令
- [SubAgent 后台任务](wiki/core-concepts/task-management/agent-task) — 委派专项任务
- [定时任务使用](wiki/getting-started/basic-usage/cron-usage) — 周期性任务

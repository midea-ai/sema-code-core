# 快速开始

本文档介绍如何在 1 分钟内快速启动一个 AI 编码 Agent。

## 方式一：Node.js 直接集成（推荐）

如果你使用 Node.js 开发，可以直接使用 `sema-core`，无需桥接服务。

### 1. 新建项目并安装依赖

```bash
mkdir my-app && cd my-app
npm init -y
npm install sema-core
```

### 2. 下载示例文件

将 [`quickstart.mjs`](https://github.com/midea-ai/sema-code-core/tree/main/example/quickstart.mjs) 下载到 `my-app` 目录，然后修改以下两处配置：

```javascript
// quickstart.mjs
const core = new SemaCore({
  workingDir: '/path/to/your/project', // Agent 将操作的目标代码仓库路径
  logLevel: 'none',                    // 日志级别：'debug' | 'info' | 'warn' | 'error' | 'none'
  thinking: false,                     // 是否显示思考过程
  disableTopicDetection: true,         // 禁用话题检测
  disableBackgroundTasks: true,        // 禁用后台任务
  maxSessions: 5,                      // 可选：同时最多保留 5 个会话
});

// 配置模型（以 qwen3.5-plus 为例）
const modelConfig = {
  "modelName": "qwen3.5-plus",         // 模型名称
  "provider": "custom",                // 服务商：'anthropic' | 'custom'
  "baseURL": "https://api.example.com/v1",  // OpenAI 兼容接口地址
  "apiKey": "sk-your-api-key",         // 替换为你的 API Key
  "maxTokens": 32000,                  // 最大输出 token 数
  "contextLength": 256000,             // 上下文长度
  "adapt": "openai"                    // 适配器：'anthropic' | 'openai'
};

const modelId = `${modelConfig.modelName}[${modelConfig.provider}]`;
await core.addModel(modelConfig);
await core.applyTaskModel({ main: modelId, quick: modelId });
```

> 💡 **提示**：`addModel` 和 `applyTaskModel` 只需运行一次，模型配置会持久化保存。后续运行可以注释掉这两行。

更多模型配置选项，请参考 [添加新模型](wiki/getting-started/basic-usage/add-new-model)。

### 3. 运行

```bash
node quickstart.mjs
```

<img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/quick-start.gif" alt="快速开始演示" />

### 4. 与 Agent 交互

启动后，你可以通过以下方式与 Agent 交互：

- **输入消息**：在提示符后输入自然语言指令
- **权限响应**：当 Agent 需要执行敏感操作时，输入：
  - `y` = `agree`（单次同意）
  - `a` = `allow`（永久放行，支持前缀匹配）
  - `n` = `refuse`（拒绝）
- **中断会话**：按 `Esc` 键或 `Ctrl+C` 中断当前任务
- **退出程序**：输入 `exit` 或 `quit`

### 5. 核心 API 说明

示例中使用的核心 API：

```javascript
// 创建会话
const result = await core.createSession();
if (!result.ok) throw new Error(result.error);
const session = result.session;

// 发送用户输入
session.processUserInput("帮我重构这个函数");

// 中断会话
session.interrupt();

// 监听会话级事件
session.on('session:ready', (data) => { ... });
session.on('message:text:chunk', ({ delta }) => { process.stdout.write(delta); });
session.on('tool:permission:request', (data) => { ... });

// 响应权限请求
session.respondToToolPermission({ toolId, toolName, selected: 'agree' });
```

完整 API 列表请参考 [SemaCore 公共 API](wiki/core-concepts/core-architecture/sema-core-public-api) 与 [SemaSession 会话级 API](wiki/core-concepts/core-architecture/sema-session-api)。

---

## 方式二：跨语言集成（C# / Java / Python）

如果你使用其他语言，可以通过 WebSocket 或 gRPC 桥接集成 `sema-core`。

### 架构

**WebSocket 方式（sema-bridge）：**
```
客户端应用 (C# / Java / Python)
    ↕ WebSocket (ws://localhost:3765)
Node.js 桥接服务 (sema-bridge)
    ↕ 内部调用
sema-core (npm 包)
```

**gRPC 方式（sema-grpc）：**
```
客户端应用 (C# / Java / Python / ...)
    ↕ gRPC 双向流 (grpc://localhost:3766)
Node.js gRPC 服务 (sema-grpc)
    ↕ 内部调用
sema-core (npm 包)
```

### 项目结构

```
example/
├── quickstart.mjs            # Node.js 直接集成（无需桥接）
│
├── sema-bridge/              # 桥接服务端 ─ WebSocket
├── sema-grpc/                # 桥接服务端 ─ gRPC
│
├── sema-csharp-demo/         # 客户端示例 ─ C#    (连接 sema-bridge)
├── sema-java-demo/           # 客户端示例 ─ Java   (连接 sema-bridge)
└── sema-python-demo/         # 客户端示例 ─ Python (连接 sema-bridge)
```

### 启动步骤

详见 [跨语言集成文档](https://github.com/midea-ai/sema-code-core/blob/main/example/README.md)。

---

## 关键概念

| 概念 | 说明 | 文档 |
|------|------|------|
| **SemaCore** | 进程级入口，管理全局资源、配置和会话池 | [SemaCore - 公共 API 层](wiki/core-concepts/core-architecture/sema-core-public-api) |
| **SemaSession** | 会话级入口，处理输入、事件、权限响应和后台任务 | [SemaSession - 会话级 API](wiki/core-concepts/core-architecture/sema-session-api) |
| **SemaEngine** | 单会话核心引擎，负责输入队列、模式控制和对话调度 | [SemaEngine - 业务逻辑](wiki/core-concepts/core-architecture/sema-engine-business-logic) |
| **事件系统** | 流式输出、状态变化、工具执行均通过事件通知 | [事件总线架构](wiki/core-concepts/event-system/event-bus) |
| **工具权限** | 写操作（RunShell、PatchFile 等）默认需要用户授权 | [权限系统](wiki/core-concepts/tool-system/permission-system) |
| **MCP** | 通过标准协议为 AI 扩展自定义工具 | [MCP 使用](wiki/getting-started/basic-usage/mcp-usage) |
| **Skill** | 可复用的 AI 工作流，存储为 Markdown 文件 | [Skill 使用](wiki/getting-started/basic-usage/skill-usage) |
| **SubAgent** | 隔离执行的专用子代理 | [SubAgent 后台任务](wiki/core-concepts/task-management/agent-task) |

---

## 下一步

- 📚 [添加新模型配置](wiki/getting-started/basic-usage/add-new-model) - 配置更多 LLM 服务商
- 🔧 [命令使用说明](wiki/getting-started/basic-usage/command-usage) - 学习内置命令
- 🤖 [SubAgent 后台任务](wiki/core-concepts/task-management/agent-task) - 委派专项任务
- ⏰ [定时任务使用](wiki/getting-started/basic-usage/cron-usage) - 设置周期性任务
- 🔌 [MCP 集成使用](wiki/getting-started/basic-usage/mcp-usage) - 接入外部工具

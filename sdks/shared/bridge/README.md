# sema-bridge

基于 gRPC 双向流的 sema-core 桥接服务（跨语言共享 sidecar 运行时），供各语言 SDK（`sdks/<lang>/`）及自行 codegen 的宿主通过 gRPC 调用 sema-core 能力。

## 架构

```
客户端应用 (Java / Python / C# / ...)
    ↕ gRPC 双向流 (grpc://127.0.0.1:3766)
Node.js gRPC 服务 (sema-bridge sidecar)
    ↕ 内部调用
sema-core (npm 包)
```

## 目录结构

```
sdks/
├── proto/
│   └── sema.proto        # Protobuf 协议定义（唯一源：bridge 运行时加载、各语言 SDK 构建期生成）
└── bridge/
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── server.ts     # gRPC 服务器入口 + action 路由
        ├── core.ts       # SemaCoreManager：进程级单例 Core + 会话池
        └── session.ts    # SessionBinder：会话级事件桥接到 gRPC 流
```

## 协议说明

### Proto 定义（`../proto/sema.proto`）

服务暴露单个双向流 RPC：

```protobuf
service SemaBridge {
  rpc Connect(stream BridgeCommand) returns (stream BridgeEvent);
}
```

**BridgeCommand**（客户端 → 服务端）

| 字段         | 类型   | 说明                                             |
|------------|------|--------------------------------------------------|
| `id`         | string | 请求 ID，用于匹配响应                              |
| `action`     | string | 操作名，见下表                                    |
| `payload`    | string | JSON 序列化的参数（可为空字符串）                   |
| `session_id` | string | 目标会话 ID；**会话级 action 必填**，进程级 action 留空 |

**BridgeEvent**（服务端 → 客户端）

| 字段         | 类型   | 说明                                          |
|------------|------|-----------------------------------------------|
| `event`      | string | 事件名，见下表                                 |
| `data`       | string | JSON 序列化的数据（可为空字符串）               |
| `cmd_id`     | string | 对应指令的 ID（仅响应类消息携带）                |
| `session_id` | string | 事件所属会话 ID；会话级事件携带，进程级事件留空    |

### 进程与会话模型

> **桥是 sema-core 的透明镜像。** action 名与 sema-core 方法名**一一对应**，事件名保持 core 原始事件名，桥不做协议翻译——「调 gRPC」等同于「调 core 方法」。

- **一个 Node 进程 = 一个共享的 SemaCore + 会话池**：模型 / 配置 等进程级能力全进程共享。
- **路由规则**：`session_id` 为空 → 调用 **SemaCore** 方法（进程级）；非空 → 路由到对应会话的 **SemaSession** 方法（该会话须已 `createSession` 成功，否则返回 `error`）。
- **`init` 非破坏式**：首次创建 Core，再次调用只做就绪确认（不销毁已有会话、不覆盖已有配置）。是唯一没有同名 core 方法的 action（对应 Core 构造）。
- `createSession` 的 `ack` 直接返回分配的 `sessionId`，`session:ready` 事件也携带同一 id。

### 支持的 Action

> 本示例（`quickstart-grpc.mjs`）用到的是下列常用 action。桥实际转发的 action 是 sema-core 方法的完整镜像（还含 Tools / Plugins / MCP / Cron / Agents / Skills / Commands / Memory / fork 撤销 / 后台任务面板等），可按需在 `src/server.ts` 的路由表查阅。

#### 进程级（Core，无需 session_id）

| Action           | 说明 / Payload                                              |
|------------------|-----------------------------------------------------------|
| `init`           | 初始化/确认 SemaCore 就绪（非破坏式），payload 为核心配置对象；ack 回 `{ ready: true }` |
| `addModel`       | 添加模型，`{ config, skipValidation? }`                     |
| `delModel`       | 删除模型，`{ modelName }`                                  |
| `switchModel`    | 切换模型，`{ modelName }`                                  |
| `applyTaskModel` | 应用任务模型，`{ main, quick }`                             |
| `getModelData`   | 获取模型信息（数据随 `ack` 的 `data` 返回）                  |
| `updateCoreConfig` | 更新核心配置                                             |
| `listSessions`   | 列出会话 ID（随 `ack` 的 `data.sessions` 返回）             |
| `createSession`  | 创建会话，可选 `{ sessionId?, permissionLevel?, mode? }`；`ack` 回 `{ sessionId }`，随后触发 `session:ready` |
| `closeSession`   | 关闭指定会话（需带 `session_id`，不销毁 Core）              |

#### 会话级（Session，需 session_id）

| Action                     | 说明 / Payload                                          |
|----------------------------|--------------------------------------------------------|
| `processUserInput`         | 发送用户消息，`{ content, orgContent?, attachments? }`   |
| `interrupt`                | 中断当前会话                                            |
| `respondToToolPermission`  | 回应工具权限请求，`{ toolId, toolName, selected }`       |
| `respondToPickOption`      | 回应选项询问，`{ agentId, answers }`                     |
| `respondToPlanExit`        | 回应计划退出请求，`{ selected }`                         |
| `updateAgentMode`          | 切换代理模式，`{ mode }`                                |
| `updatePermissionLevel`    | 切换权限档位，`{ level }`                               |

### 典型调用流程

```
init  ─▶  addModel  ─▶  applyTaskModel  ─▶  createSession
                                                 │
                                    ack 回 { sessionId }（session:ready 事件也带同一 id）
                                                 ▼
                    processUserInput ⇄ (message:*/tool:* 等事件流)   ← 均带 session_id
                                                 │
                                           closeSession
```

- 每条指令都会收到一帧 `ack`（或 `error`），其 `cmd_id` 等于指令的 `id`，可用于按序等待。
- 会话级指令（`processUserInput` / `interrupt` / `respondTo*` / `closeSession`）必须带上 `createSession` 返回的 `session_id`。
- 模型相关 action 只需配置一次，后续可复用。
- 交互场景建议在 `init` 的配置中加 `disabledTools: ['ask_form', 'plan_to_agent']` 禁用无法应答的工具。

### 服务端推送的事件（Event）

| Event                      | 说明              |
|----------------------------|-------------------|
| `session:ready`            | 会话已就绪，含 `sessionId` |
| `session:error`            | 会话错误           |
| `session:interrupted`      | 会话已中断          |
| `session:cleared`          | 会话已清空          |
| `state:update`             | 状态变化（`idle` / `processing`）  |
| `input:received`           | 用户输入已接收       |
| `input:processing`         | 用户输入开始处理     |
| `message:text:chunk`       | AI 文本流式输出片段  |
| `message:thinking:chunk`   | AI 思考流式输出片段  |
| `message:complete`         | 本轮消息输出完成     |
| `tool:permission:request`  | 请求工具执行权限     |
| `tool:execution:complete`  | 工具执行完成        |
| `tool:execution:chunk`     | 工具执行中间态      |
| `tool:execution:error`     | 工具执行错误        |
| `task:agent:start`         | 子 Agent 启动      |
| `task:agent:end`           | 子 Agent 结束      |
| `task:start`               | 后台任务启动        |
| `task:end`                 | 后台任务结束        |
| `todos:update`             | 待办事项更新        |
| `topic:update`             | 会话主题更新        |
| `pick:option:request`      | AI 发起选项询问     |
| `plan:exit:request`        | AI 请求退出计划模式  |
| `permissionLevel:update`   | 权限档位变更        |
| `conversation:usage`       | Token 使用统计     |
| `file:reference`           | 文件引用信息        |
| `ack`                      | 指令确认（含 `cmd_id`）|
| `error`                    | 错误事件（含 `cmd_id`）|

> 会话级事件均带 `session_id`；进程级事件（如 `ack` 进程级指令、模型广播等）`session_id` 留空。

## 环境要求

- Node.js 18+
- npm

## 安装与启动

```bash
cd sdks/bridge
npm install
npm run build        # esbuild 单文件打包 → dist/server.js + dist/sema.proto（自包含，运行不需要 node_modules）
npm start
```

> 产物形态与 JetBrains 插件 sidecar 一致：`dist/server.js`（含 sema-core，`@vscode/ripgrep` 被 external，
> rg 由 SDK runtime 供应并前置进子进程 PATH）+ 同级 `sema.proto`。`npm run build:tsc` 保留 tsc 多文件构建，
> `npm run typecheck` 只做类型检查。

## 环境变量

| 变量名               | 默认值          | 说明                   |
|---------------------|----------------|------------------------|
| `SEMA_BRIDGE_PORT`  | `3766`         | gRPC 服务监听端口（传 `0` 由系统分配，实际端口从 stdout 的 `SEMA_BRIDGE_PORT_ACTUAL=` 行读取） |
| `SEMA_WORKING_DIR`  | 当前工作目录     | Agent 操作的目标代码仓库路径 |

示例：

```bash
SEMA_BRIDGE_PORT=3766 SEMA_WORKING_DIR=/path/to/your/project npm start
```

## 快速测试

服务启动后，可使用同目录下的 `quickstart-grpc.mjs` 进行基本连通性测试（单会话交互 demo）。
执行前修改配置：
```javascript
// sdks/bridge/quickstart-grpc.mjs
const WORKING_DIR = '/path/to/your/project';  // Agent 将操作的目标代码仓库路径
"apiKey": "sk-your-api-key",  // 替换为你的 API Key
```

执行：
```bash
cd sdks/bridge
node quickstart-grpc.mjs
```

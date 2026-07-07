# sema-bridge

> ⚠️ **维护状态**：早期 WebSocket 示例，很久未更新、API 与事件均不完整，仅作最简参考保留，**后续不再更新**。跨语言集成请优先使用 [sema-grpc](../sema-grpc/README.md)（API/事件完整，且有生产工程在用）。

基于 WebSocket 的 sema-core 桥接服务，供 C# / Java / Python 等客户端通过 WebSocket 调用 sema-core 能力。

## 架构

```
客户端应用 (C# / Java / Python)
    ↕ WebSocket (ws://localhost:3765)
Node.js 桥接服务 (sema-bridge)
    ↕ 内部调用
sema-core (npm 包)
```

## 目录结构

```
sema-bridge/
├── package.json
├── tsconfig.json
└── src/
    ├── server.ts         # WebSocket 服务器入口
    ├── session.ts        # 会话管理
    └── protocol.ts       # 指令/事件帧定义
```

## 协议说明

服务端与客户端通过 WebSocket 收发 JSON 文本帧。

**BridgeCommand**（客户端 → 服务端）

| 字段      | 类型   | 说明                          |
|---------|------|-------------------------------|
| `id`      | string | 请求 ID，用于匹配响应             |
| `action`  | string | 操作名，见下表                  |
| `payload` | object | 参数对象（可省略）                |

**BridgeEvent**（服务端 → 客户端）

| 字段      | 类型   | 说明                          |
|---------|------|-------------------------------|
| `event`   | string | 事件名，见下表                  |
| `data`    | object | 事件数据（可省略）                |
| `cmdId`   | string | 对应指令的 ID（仅响应类消息携带）  |

### 支持的 Action

> 作用域说明：**Core** 级 action 作用于 SemaCore（模型/配置）；**Session** 级 action 作用于当前会话，**必须先 `session.create` 成功后**才能调用，否则返回 `error`。

| Action              | 作用域 | Payload 说明                                      |
|---------------------|--------|--------------------------------------------------|
| `config.init`       | Core   | 重新初始化 SemaCore（会重建实例并丢弃当前会话），payload 为核心配置对象 |
| `model.add`         | Core   | 添加模型，`{ config, skipValidation? }`             |
| `model.del`         | Core   | 删除模型，`{ modelName }`                          |
| `model.applyTask`   | Core   | 应用任务模型，`{ main, quick }`                     |
| `model.switch`      | Core   | 切换模型，`{ modelName }`                          |
| `model.getData`     | Core   | 获取模型信息（数据随 `ack` 的 `data` 返回）          |
| `config.update`     | Core   | 更新核心配置                                       |
| `session.create`    | Core   | 创建会话，可选传入 `{ sessionId }`（加载历史）；成功后触发 `session:ready` |
| `session.input`     | Session| 发送用户消息，`{ content, orgContent? }`            |
| `session.interrupt` | Session| 中断当前会话                                       |
| `session.dispose`   | Session| 关闭当前会话（`closeSession`，不销毁 Core）          |
| `permission.respond`| Session| 回应工具权限请求，`{ toolId, toolName, selected }`    |
| `question.respond`  | Session| 回应选项询问，`{ agentId, answers }`                |
| `plan.respond`      | Session| 回应计划退出请求，`{ selected }`                     |
| `config.updateAgentMode` | Session | 切换代理模式，`{ mode }`                       |

### 典型调用流程

```
config.init  ─▶  model.add  ─▶  model.applyTask  ─▶  session.create
                                                          │
                                            等待 session:ready 事件
                                                          ▼
                              session.input ⇄ (message:*/tool:* 等事件流)
                                                          │
                                                  session.dispose
```

- 每条指令都会收到一帧 `ack`（或 `error`），其 `cmdId` 等于指令的 `id`，可用于按序等待。
- 回合结束信号：以「主代理回到 `state:update==='idle'`」为准（整轮含工具调用结束后只发一次 idle）。会话初始即 idle，不会触发 `state:update`，故首条输入靠 `session:ready` 触发。
- 交互场景建议在 `config.init` 的配置中加 `disabledTools: ['ask_form', 'plan_to_agent']` 禁用无法应答的工具。

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
| `tool:execution:start`     | 工具开始执行        |
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
| `conversation:usage`       | Token 使用统计     |
| `file:reference`           | 文件引用信息        |
| `ack`                      | 指令确认（含 `cmdId`）|
| `error`                    | 错误事件（含 `cmdId`）|

## 环境要求

- Node.js 18+
- npm

## 安装与启动

```bash
cd sema-bridge
npm install
npm run build
npm start
```

## 环境变量

| 变量名               | 默认值          | 说明                   |
|---------------------|----------------|------------------------|
| `SEMA_BRIDGE_PORT`  | `3765`         | WebSocket 服务监听端口   |
| `SEMA_WORKING_DIR`  | 当前工作目录     | Agent 操作的目标代码仓库路径 |

示例：

```bash
SEMA_BRIDGE_PORT=3765 SEMA_WORKING_DIR=/path/to/your/project npm start
```

## 客户端示例

C# / Java / Python 客户端示例见 [sema-bridge-clients](../sema-bridge-clients/README.md)。

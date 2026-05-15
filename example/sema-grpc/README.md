# sema-grpc

基于 gRPC 双向流的 sema-core 桥接服务，供 C# / Java / Python 等客户端通过 gRPC 调用 sema-core 能力。

## 架构

```
客户端应用 (C# / Java / Python / ...)
    ↕ gRPC 双向流 (grpc://localhost:3766)
Node.js gRPC 服务 (sema-grpc)
    ↕ 内部调用
sema-core (npm 包)
```

## 目录结构

```
sema-grpc/
├── package.json
├── tsconfig.json
├── proto/
│   └── sema.proto        # Protobuf 协议定义
└── src/
    ├── server.ts         # gRPC 服务器入口
    └── session.ts        # 会话管理
```

## 协议说明

### Proto 定义（`proto/sema.proto`）

服务暴露单个双向流 RPC：

```protobuf
service SemaBridge {
  rpc Connect(stream BridgeCommand) returns (stream BridgeEvent);
}
```

**BridgeCommand**（客户端 → 服务端）

| 字段      | 类型   | 说明                          |
|---------|------|-------------------------------|
| `id`    | string | 请求 ID，用于匹配响应             |
| `action`  | string | 操作名，见下表                  |
| `payload` | string | JSON 序列化的参数（可为空字符串）  |

**BridgeEvent**（服务端 → 客户端）

| 字段      | 类型   | 说明                          |
|---------|------|-------------------------------|
| `event`   | string | 事件名，见下表                  |
| `data`    | string | JSON 序列化的数据（可为空字符串） |
| `cmd_id`  | string | 对应指令的 ID（仅响应类消息携带）  |

### 支持的 Action

| Action              | Payload 说明                                      |
|---------------------|--------------------------------------------------|
| `config.init`       | 重新初始化 SemaCore，payload 为核心配置对象           |
| `session.create`    | 创建会话，可选传入 `{ sessionId }`                  |
| `session.input`     | 发送用户消息，`{ content, orgContent? }`            |
| `session.interrupt` | 中断当前会话                                       |
| `session.dispose`   | 销毁会话                                           |
| `permission.respond`| 回应工具权限请求，`{ toolId, toolName, selected }`    |
| `question.respond`  | 回应选项询问，`{ agentId, answers }`                |
| `plan.respond`      | 回应计划退出请求，`{ selected }`                     |
| `model.add`         | 添加模型，`{ config, skipValidation? }`             |
| `model.del`         | 删除模型，`{ modelName }`                          |
| `model.applyTask`   | 应用任务模型，`{ main, quick }`                     |
| `model.switch`      | 切换模型，`{ modelName }`                          |
| `model.getData`     | 获取模型信息                                       |
| `config.update`     | 更新核心配置                                       |
| `config.updateAgentMode` | 切换代理模式，`{ mode }`                       |

### 服务端推送的事件（Event）

| Event                      | 说明              |
|----------------------------|-------------------|
| `session:ready`            | 会话已就绪，含 `sessionId` |
| `session:error`            | 会话错误           |
| `session:interrupted`      | 会话已中断          |
| `session:cleared`          | 会话已清空          |
| `state:update`             | 状态变化（`idle` / `running`）  |
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
| `conversation:usage`       | Token 使用统计     |
| `file:reference`           | 文件引用信息        |
| `ack`                      | 指令确认（含 `cmd_id`）|
| `error`                    | 错误事件（含 `cmd_id`）|

## 环境要求

- Node.js 18+
- npm

## 安装与启动

```bash
cd sema-grpc
npm install
npm run build
npm start
```

## 环境变量

| 变量名               | 默认值          | 说明                   |
|---------------------|----------------|------------------------|
| `SEMA_BRIDGE_PORT`  | `3766`         | gRPC 服务监听端口        |
| `SEMA_WORKING_DIR`  | 当前工作目录     | Agent 操作的目标代码仓库路径 |

示例：

```bash
SEMA_BRIDGE_PORT=3766 SEMA_WORKING_DIR=/path/to/your/project npm start
```

## 快速测试

服务启动后，可使用同目录下的 `quickstart-grpc.mjs` 进行基本连通性测试：

```bash
cd sema-grpc
node quickstart-grpc.mjs
```

# 事件总线（EventBus）

Sema Core 通过事件总线实现各模块间的解耦通信。所有外部可观察的状态变化都以事件形式传播。

## 架构设计

事件总线由三层组成：

| 层 | 类 | 职责 |
|---|-----|------|
| 底层 | `EventEmitter` | 基础发布-订阅，监听器携带 `sessionId` 路由标签，同步执行 |
| 上层 | `EventBus` | 进程内单例传输层，增加静默事件过滤、调试日志和 sessionId 路由 |
| 会话层 | `SessionEventBus` | 包装 `EventBus`，让 `SemaSession` 的 emit/on/once 自动绑定当前 `sessionId` |

```javascript
// src/events/EventSystem.ts

// EventBus 是单例
const eventBus = EventBus.getInstance()

// SemaCore 订阅进程级事件：
core.on<CronUpdateData>('cron:update', listener)
core.once<MCPServerStatusData>('mcp:server:status', listener)
core.off('cron:update', listener)

// SemaSession 订阅会话级事件：
session.on(event, listener)
session.once(event, listener)
session.off(event, listener)
```

底层 `EventEmitter` 的实现要点：

- **同步执行**：`emit()` 同步遍历所有监听器，避免异步陷阱
- **异常隔离**：单个监听器抛错不会影响其他监听器，错误通过 `logError` 记录
- **once 实现**：内部创建 `onceWrapper`，首次调用后自动 `off`

## API 参考

### 监听方法

进程级事件通过 `SemaCore` 订阅：

```typescript
core.on<T>(event: ProcessEvent, listener: (data: T) => void): SemaCore
core.once<T>(event: ProcessEvent, listener: (data: T) => void): SemaCore
core.off<T>(event: ProcessEvent, listener: (data: T) => void): SemaCore
```

会话级事件通过 `SemaSession` 订阅：

```typescript
session.on<T>(event: string, listener: (data: T) => void): SemaSession
session.once<T>(event: string, listener: (data: T) => void): SemaSession
session.off<T>(event: string, listener: (data: T) => void): SemaSession
```

所有方法返回自身实例，支持链式调用。泛型 `<T>` 建议明确指定数据类型：

```typescript
interface TextChunkData {
  id: string     // 消息唯一ID
  delta: string  // 本次新增的文本片段
}

session.on<TextChunkData>('message:text:chunk', ({ delta }) => {
  process.stdout.write(delta)
})
```

### 响应发送方法

会话级交互响应通过 `SemaSession` 发送：

```typescript
session.respondToToolPermission(response: ToolPermissionResponse): void
session.respondToPickOption(response: PickOptionResponseData): void
session.respondToPlanExit(response: PlanExitResponseData): void
```

### EventBus 完整方法

内部 `EventBus` 单例还提供以下方法（不通过 SemaCore 直接暴露）：

```typescript
eventBus.removeAllListeners(event?: string): this   // 移除指定/所有监听器
eventBus.removeSessionListeners(sessionId: string): this // 移除指定会话注册的监听器
eventBus.hasListeners(event: string): boolean        // 检查是否有监听器
eventBus.listenerCount(event: string): number        // 获取监听器数量
eventBus.eventNames(): string[]                      // 获取所有已注册事件名
```

## 事件命名规范

事件名采用 `namespace:action[:detail]` 格式：

| 命名空间 | 含义 | 典型事件 |
|---------|------|---------|
| `session` | 会话生命周期 | `session:ready`, `session:interrupted`, `session:error`, `session:cleared` |
| `state` | 运行状态 | `state:update` |
| `input` | 用户输入 | `input:received`, `input:processing` |
| `message` | AI 消息 | `message:text:chunk`, `message:thinking:chunk`, `message:complete` |
| `tool` | 工具执行 | `tool:permission:request`, `tool:execution:complete`, `tool:execution:chunk`, `tool:execution:error` |
| `todos` | 待办事项 | `todos:update` |
| `permissionLevel` | 权限档位 | `permissionLevel:update` |
| `topic` | 话题检测 | `topic:update` |
| `conversation` | 对话统计 | `conversation:usage` |
| `compact` | 上下文压缩 | `compact:exec` |
| `file` | 文件引用 | `file:reference` |
| `pick` | 问答交互 | `pick:option:request` |
| `plan` | Plan 模式 | `plan:exit:request`, `plan:exit:response`, `plan:implement` |
| `task` | 任务/子代理 | `task:agent:start`, `task:agent:end`, `task:start`, `task:end`, `task:transfer` |
| `quickchat` | 旁路问答 | `quickchat:response` |
| `cron` | 定时任务（进程级） | `cron:update` |
| `mcp` | MCP 协议（进程级） | `mcp:server:status` |
| `config` | 配置 | `config:no_models` |

## 典型使用模式

### 流式输出

```typescript
let fullText = ''

session.on<TextChunkData>('message:text:chunk', ({ delta }) => {
  process.stdout.write(delta)
  fullText += delta
})

session.on<MessageCompleteData>('message:complete', ({ content, reasoning }) => {
  if (reasoning) {
    console.log('\n\n思考过程:', reasoning)
  }
  console.log('\n\n完整响应:', content)
})
```

### 状态监听

```typescript
session.on<StateUpdateData>('state:update', ({ state }) => {
  if (state === 'processing') showSpinner()
  else if (state === 'idle') hideSpinner()
})
```

### 等待空闲

```typescript
function waitForIdle(): Promise<void> {
  return new Promise(resolve => {
    const handler = ({ state }: StateUpdateData) => {
      if (state === 'idle') {
        session.off('state:update', handler)
        resolve()
      }
    }
    session.on('state:update', handler)
  })
}
```

### 工具执行监控

```typescript
session.on<ToolExecutionCompleteData>('tool:execution:complete', ({ agentId, toolName, summary }) => {
  const prefix = agentId === 'main' ? '' : `[SubAgent ${agentId}] `
  console.log(`${prefix}✓ ${toolName}: ${summary}`)
})

session.on<ToolExecutionErrorData>('tool:execution:error', ({ toolName, content }) => {
  console.error(`✗ ${toolName}: ${content}`)
})
```

### 权限响应

```typescript
// 监听工具权限请求
session.on<ToolPermissionRequestData>('tool:permission:request', (data) => {
  // 自动批准只读工具
  const readOnlyTools = ['read', 'grep', 'glob', 'list_crons']
  if (readOnlyTools.includes(data.toolName)) {
    session.respondToToolPermission({
      toolId: data.toolId,
      toolName: data.toolName,
      selected: 'agree'
    })
  }
  // 其他工具由 UI 层展示给用户选择
})
```

## 性能说明

- **静默事件**：`message:thinking:chunk` 和 `message:text:chunk` 在高频流式输出时不记录调试日志，避免日志噪音影响性能
- **tool:execution:chunk**：仅 `fetch_url` 工具记录日志，其他工具不记录
- **同步执行**：所有监听器同步调用，流式事件中的监听器应尽量轻量，避免阻塞消息管道
- **日志按会话拆分**：事件日志和 LLM 日志在提供 sessionId 时会按会话拆分存储，文件名格式为 `YYYY-MM-DD_[sessionId].log`，便于多会话场景下的日志隔离与排查

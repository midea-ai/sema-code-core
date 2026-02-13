# 事件总线架构

Sema Code Core 通过事件总线实现各模块间的解耦通信。所有外部可观察的状态变化都以事件形式传播。

## 设计

事件总线（`EventBus`）是一个单例，基于自定义 `EventEmitter` 实现发布-订阅模式（同步执行）：

```javascript
// 内部单例
const eventBus = EventBus.getInstance()

// 通过 SemaCore 对外暴露
sema.on('event-name', listener)
sema.once('event-name', listener)
sema.off('event-name', listener)
```


## API

所有方法都通过 `SemaCore` 实例访问，并返回实例本身以支持链式调用：

```javascript
// 持续监听某个事件
sema.on<T>(event: string, listener: (data: T) => void): SemaCore

// 只监听一次，触发后自动移除
sema.once<T>(event: string, listener: (data: T) => void): SemaCore

// 取消监听
sema.off<T>(event: string, listener: (data: T) => void): SemaCore
```

支持泛型，建议明确指定数据类型：

```javascript
interface TextChunkData {
  content: string   // 累积的全部文本
  delta: string     // 本次新增的文本片段
}

sema.on<TextChunkData>('message:text:chunk', ({ delta }) => {
  process.stdout.write(delta)
})
```


## 事件命名规范

事件名采用 `namespace:action[:detail]` 格式：

| 命名空间 | 含义 |
|---------|------|
| `session` | 会话生命周期 |
| `state` | 运行状态 |
| `message` | AI 消息 |
| `tool` | 工具执行 |
| `plan` | Plan 模式 |
| `todos` | 任务列表 |
| `ask` | 问答交互 |
| `task` | SubAgent |
| `conversation` | 对话统计 |
| `compact` | 上下文压缩 |
| `topic` | 话题检测 |
| `file` | 文件引用 |


## 典型使用模式

### 流式输出

```javascript
let fullText = ''

sema.on('message:text:chunk', ({ delta }) => {
  process.stdout.write(delta)
  fullText += delta
})

sema.on('message:complete', ({ content }) => {
  console.log('\n\n完整响应:', content)
})
```

### 状态轮询替代

```javascript
// 不要轮询状态，改用事件
sema.on('state:update', ({ state }) => {
  if (state === 'processing') showSpinner()
  if (state === 'idle') hideSpinner()
})
```

### 一次性响应等待

```javascript
function waitForIdle(): Promise<void> {
  return new Promise(resolve => {
    sema.once('state:update', ({ state }) => {
      if (state === 'idle') resolve()
    })
  })
}

sema.processUserInput('执行某个任务')
await waitForIdle()
console.log('任务完成')
```

### 工具执行监控

```javascript
sema.on('tool:execution:complete', ({ agentId, toolName, summary, content }) => {
  const prefix = agentId === 'main' ? '' : `[SubAgent ${agentId}] `
  console.log(`${prefix}✓ ${toolName}: ${summary}`)
})

sema.on('tool:execution:error', ({ toolName, content }) => {
  console.error(`✗ ${toolName}: ${content}`)
})
```


## 性能说明

流式消息事件（`message:text:chunk`、`message:thinking:chunk`）在高频触发时不记录调试日志，避免日志噪音影响性能。

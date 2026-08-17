# SemaSession — 会话级 API

`SemaSession` 表示一个独立会话，由 `SemaCore.createSession()` 创建并返回。它承载对话输入、会话级事件、权限响应、Agent 模式、权限档位和后台任务等能力。

`SemaCore` 负责进程级资源和会话池；`SemaSession` 负责单个会话的交互。

## 创建会话

```javascript
import { SemaCore } from 'sema-core'

const core = new SemaCore({ workingDir: '/path/to/project' })

const result = await core.createSession({
  sessionId: 'existing-session-id', // 可选：恢复已有历史
  agentMode: 'Agent',               // 可选：'Agent' | 'Plan' | 'Design'
  permissionLevel: 'Ask',           // 可选：'Ask' | 'AutoEdit' | 'AutoRun' | 'Bypass'，默认 'Ask'
  mainModel: 'gpt-4o[openai]',      // 可选：会话级主要模型（profile 名），仅本会话生效、不持久化
  quickModel: 'gpt-4o-mini[openai]',// 可选：会话级快速模型，不传沿用全局配置
})

if (!result.ok) {
  throw new Error(result.error)
}

const session = result.session
console.log(session.sessionId)
```

`createSession()` 返回联合类型：

```typescript
type CreateSessionResult =
  | { ok: true; session: SemaSession }
  | { ok: false; error: string }
```

当 `SemaCoreConfig.maxSessions` 限制被触发时，`createSession()` 返回 `{ ok: false, error }`，不会抛异常。重复使用相同 `sessionId` 创建会话时，会复用会话池里的已有实例。

## 事件接口

```javascript
session.on<T>(event: string, listener: (data: T) => void): SemaSession
session.once<T>(event: string, listener: (data: T) => void): SemaSession
session.off<T>(event: string, listener: (data: T) => void): SemaSession
```

会话级事件会按 `sessionId` 路由，同一个进程中的多个会话不会互相收到对方的消息流、状态变化、工具权限请求或后台任务事件。

```javascript
session
  .on('message:text:chunk', ({ delta }) => process.stdout.write(delta || ''))
  .on('state:update', ({ state }) => console.log(state))
  .on('tool:permission:request', handlePermission)
```

> `session:ready` 和 `config:no_models` 会延迟一拍发送，调用方可以在拿到 `SemaSession` 后立即注册监听器。

## 用户输入与中断

```javascript
// 非阻塞：立即返回，异步执行
session.processUserInput('帮我重构这个函数')

// 中断当前会话正在执行的请求
session.interrupt()
```

处理中再次调用 `processUserInput()` 时，新输入会进入该会话自己的输入队列：以 `/` 开头的命令单独成批，普通消息会作为 `inject` 输入合并处理。`/quickchat <question>` 是旁路问答，回复通过 `quickchat:response` 事件返回。

## 权限与交互响应

AI 执行过程中可能通过事件请求用户响应。响应方法都在 `SemaSession` 上，响应只作用于当前会话。

```javascript
session.respondToToolPermission({
  toolId,
  toolName,
  selected: 'agree', // 'agree' | 'allow' | 'refuse' | string
})

session.respondToPickOption({
  agentId,
  answers: '用户选择的答案',
})

session.respondToPlanExit({
  agentId,
  selected: 'startEditing', // 或 'clearContextAndStart'
})
```

文件编辑的 `allow` 权限是会话级状态：授权后只在当前 `SemaSession` 内生效。

## 会话级配置

```javascript
session.updateAgentMode('Plan')              // 'Agent' | 'Plan' | 'Design'
session.updatePermissionLevel('AutoEdit')    // 'Ask' | 'AutoEdit' | 'AutoRun' | 'Bypass'
```

`agentMode` 从全局配置读取默认值，也可以在 `createSession({ agentMode })` 时指定初始值。`permissionLevel` 默认 `'Ask'`，可在 `createSession({ permissionLevel })` 时指定初始值，变更时触发 `permissionLevel:update` 事件。之后的切换只影响当前会话，不会改写其它会话。

会话创建时会生成一份系统提示快照（包含环境、git 状态等），同一会话内复用该快照，避免运行中因外部状态变化导致提示词漂移。

## 后台任务

后台任务 API 也按会话隔离：

```javascript
session.getTaskList(): TaskListItem[]
session.watchTask(taskId, onDelta): () => void
session.stopTask(taskId): boolean
session.stopAllTasks(): number
session.transferAgentToBackground(taskId): boolean
session.transferAllForegroundAgents(): string[]
```

- `getTaskList()` 只返回当前会话的后台任务。
- `stopAllTasks()` 只停止当前会话的任务。
- `MAX_RUNNING_TASKS = 5` 按会话独立计算。
- 任务结束后内存中的输出会释放；`watchTask()` 和 `peek_bg_job` 会从输出文件读取历史输出。

## 关闭会话

```javascript
session.dispose()

// 通常由 SemaCore 统一管理：
core.closeSession(session.sessionId)
```

关闭会话时会中断该会话正在执行的请求，移除会话级事件监听器，清理该会话的状态、后台任务和通知回调。`SemaCore.dispose()` 会关闭所有会话并释放进程级单例资源。

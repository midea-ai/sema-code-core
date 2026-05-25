# SemaEngine — 单会话业务逻辑

`SemaEngine` 是单个会话的核心引擎。每个 `SemaSession` 持有一个 `SemaEngine`，并绑定固定的 `sessionId` 与 `SessionEventBus`。外部不直接访问 `SemaEngine`，而是通过 [SemaSession - 会话级 API](wiki/core-concepts/core-architecture/sema-session-api) 调用。

## 职责概述

- 初始化单个会话：加载历史、恢复 Todos、发送 `session:ready`
- 维护该会话的用户输入队列
- 处理 `/quickchat` 旁路问答
- 注入当前会话的后台任务与定时任务通知回调
- 处理用户输入的完整流程：命令解析 → 文件引用 → 系统提示快照 → 对话循环
- 根据会话级 `agentMode` 注入模式提醒
- 管理该会话的 `AbortController`，支持中断
- 通过 `SessionEventBus` 发布会话级事件

## 内部状态

```typescript
class SemaEngine {
  readonly sessionId: string
  private readonly bus: SessionEventBus
  private readonly runtime: SessionRuntime
  private currentProcessingPromise: Promise<void> | null
}
```

`runtime` 来自 `getStateManager().session(sessionId)`，包含该会话的消息历史、Todos、输入队列、权限状态、当前中断控制器和 Agent 模式等状态。

构造时会按 `sessionId` 注册通知回调：

```javascript
getTaskManager().setNotifyCallback(sessionId, (msg) => {
  this.processUserInput(msg, undefined, true)
})

getCronManager().setNotifyCallback(sessionId, (msg) => {
  this.processUserInput(msg, undefined, true)
})
```

后台任务或定时任务触发后，只会把 `silent` 输入注入目标会话。

## 会话初始化

```javascript
async createSession(opts?: CreateSessionOptions): Promise<void>
```

初始化流程：

```
1. initialize()：设置日志级别，检查 main 模型
2. 设置会话级 agentMode：opts.agentMode > coreConfig.agentMode > 'Agent'
3. 设置会话级 permissionLevel：opts.permissionLevel > 'Ask'
4. 构建并冻结系统提示快照 formatSystemPrompt()
5. loadHistory(opts.sessionId, workingDir) 恢复历史
6. 恢复主代理消息历史、Todos、TodoTasks、文件读取时间戳
7. 读取项目输入历史与 token 使用量
8. setImmediate 发送 session:ready
9. 将主代理状态置为 idle
```

`session:ready` 事件数据：

```javascript
{
  pid: number,
  workingDir: string | undefined,
  sessionId: string,
  historyLoaded: boolean,
  projectInputHistory: string[],
  usage: { useTokens, maxTokens, promptTokens },
  todos: TodoItem[],
  readFileTimestamps: Record<string, number>
}
```

`session:ready` 延迟一拍发送，确保调用方拿到 `SemaSession` 后可以先注册监听器。

## 用户输入处理流程

```javascript
processUserInput(input: string, originalInput?: string, silent?: boolean): void
```

入口分流：

```
1. 生成 8 位 inputId
2. 若 input 是 `/quickchat` 或以 `/quickchat ` 开头 → 保存输入历史；有问题文本时异步调用 handlequickchat，无问题文本时直接发送空 quickchat 响应；不进入主状态机
3. 若当前会话处于 processing
   - 以 / 开头 → type='command'
   - 普通消息 → type='inject'
   - 写入当前会话 pendingUserInputs
   - 非 silent 输入发送 input:received { queued: true }
4. 若当前会话空闲
   - 非 silent 输入发送 input:received { queued: false }
   - startQuery([{ inputId, input, originalInput, silent }])
```

`silent` 输入用于后台任务与 Cron 通知，不触发用户可见的输入接收/处理事件，也不会保存到输入历史。

## startQuery：构建执行上下文

```
1. runtime.forAgent(MAIN_AGENT_ID).updateState('processing')
2. 创建 AbortController，写入 runtime.currentAbortController
3. 读取会话级 agentMode
4. getAvailableTools() 构建工具列表
5. 构建 AgentContext：
   {
     sessionId,
     agentId: MAIN_AGENT_ID,
     abortController,
     tools,
     model: 'main'
   }
6. currentProcessingPromise = processQuery(inputs, agentContext, agentMode)
```

工具列表每轮重新构建：内置工具按核心配置 `useTools` 过滤（`disabledTools` 会在配置层转换为 `useTools`），MCP 工具由 `MCPManager` 提供并按 MCP 自身配置控制。`disableBackgroundTasks` 会在 schema 层面移除 `run_shell` / `sub_agent` 的后台字段。

## processQuery：执行查询

```
1. 对每条非 silent 输入发送 input:processing
2. 保存非 silent 输入到项目历史
3. handleCommand(input, sessionId)
   - 系统命令返回 null，跳过该输入；若本批没有任何 blocks，则跳过本轮 LLM 调用
   - 其它命令返回 processedText + blocks
4. 后台执行话题检测（silent 输入不更新话题）
5. processFileReferences(combinedProcessedText, agentContext)
6. 读取会话级系统提示快照；缺失时兜底构建一次并写回 runtime
7. buildAdditionalReminders(..., sessionId, hasSkillTool)
8. 构建用户消息并拼接历史消息
9. 调用 ReAct 会话循环
   - Conversation 驱动 LLM 流式输出与工具循环
```

与旧实现不同，系统提示不再每轮都重新构建。会话创建时会保存一份快照，同一会话内复用，保证环境信息、git 状态等提示内容稳定。

## finally：队列消费

无论查询成功、报错还是被中断，`processQuery.finally` 都会执行：

```
1. 延迟清空 runtime.currentAbortController，避免中断竞态
2. consumeAllPendingInputs()
3. takeNextBatch()
   - command 类型单独成批
   - inject 类型可合并成批
4. 若有下一批 → startQuery(batch)
5. 否则 → updateState('idle')
```

多会话不再通过 `pendingSession` 切换。新会话由 `SessionPool` 创建并并存；旧会话仍可继续处理自己的队列，除非调用方显式 `session.interrupt()` 或关闭该会话。

## Agent 模式与权限档位

```javascript
updateAgentMode(mode: 'Agent' | 'Plan' | 'Design'): void
updatePermissionLevel(level: 'Ask' | 'AutoEdit' | 'AutoRun'): void
```

这些配置写入当前会话的 `SessionRuntime`，不会影响其它会话。切换到 Plan 或 Design 模式时，会重置对应的模式提示发送标记，使下一轮对话重新注入模式说明。`updatePermissionLevel()` 设置会话级权限自由度档位（`'Ask'` / `'AutoEdit'` / `'AutoRun'`），档位决定需要确认的工具被自动放行的力度（详见[权限系统](wiki/core-concepts/tool-system/permission-system)），变更时触发 `permissionLevel:update` 事件。

## 中断与释放

```javascript
interruptSession(): void
dispose(): void
```

`interruptSession()` 只中断当前会话的 `AbortController`。队列是否继续消费由 `finally` 决定。

`dispose()` 是会话级清理：

```
1. abortCurrentRequest()
2. runtime.clearPendingUserInputs()
3. 移除 TaskManager / CronManager 中该 sessionId 的通知回调
```

完整关闭流程由 `SemaSession.dispose()` 负责：除引擎清理外，还会清理该会话的后台任务、状态和事件监听器。

## 事件发布

`SemaEngine` 和它驱动的 Conversation/RunTools 会通过 `SessionEventBus` 发布会话级事件：

| 阶段 | 事件 |
|------|------|
| 会话就绪 | `session:ready` |
| 模型配置缺失 | `config:no_models` |
| 会话错误 | `session:error` |
| 会话中断 | `session:interrupted` |
| 会话清空 | `session:cleared` |
| 用户输入 | `input:received`, `input:processing` |
| 状态变化 | `state:update` |
| 文件引用 | `file:reference` |
| 主题检测 | `topic:update` |
| 对话消息 | `message:thinking:chunk`, `message:text:chunk`, `message:complete` |
| 工具执行 | `tool:permission:request`, `tool:execution:chunk`, `tool:execution:complete`, `tool:execution:error` |
| 子代理 | `task:agent:start`, `task:agent:end` |
| 后台任务 | `task:start`, `task:end`, `task:transfer` |
| Plan 模式 | `plan:exit:request`, `plan:exit:response`, `plan:implement` |
| 提问交互 | `pick:option:request`, `pick:option:response` |
| 待办更新 | `todos:update` |
| Token 统计 | `conversation:usage` |
| 上下文压缩 | `compact:exec` |
| QuickChat | `quickchat:response` |

进程级事件（`cron:update`、`mcp:server:status`）不属于 `SemaEngine` 会话事件，由 `SemaCore.on/once/off` 订阅。

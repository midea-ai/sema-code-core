# SemaEngine — 业务逻辑

`SemaEngine` 是 Sema Core 的核心引擎，负责协调所有子系统的初始化和运行时调度。它被 `SemaCore` 内部持有，外部不直接访问。

## 职责概述

- 管理会话生命周期与切换（`pendingSession` + `currentProcessingPromise`）
- 维护用户输入队列（处理中收到的输入按 `command`/`inject` 类型入队）
- 处理 `/quickchat` 旁路问答（不影响主对话状态）
- 注入 `TaskManager` 后台任务通知回调
- 注入 `CronManager` 定时任务通知回调
- 处理用户输入的完整流程（命令解析 → 文件引用 → 系统提示词 → 对话）
- 根据模式（Agent/Plan）动态构建工具集
- 管理 `AbortController` 实现可中断
- 向事件总线发布各阶段事件

## 内部状态

```javascript
private pendingSession: string | null            // 待切换的会话 ID（仅保留最新一个）
private currentProcessingPromise: Promise<void> | null  // 当前 processQuery 的 Promise
private eventBus = EventBus.getInstance()        // 事件总线单例
```

构造时会向 `TaskManager` 和 `CronManager` 注入通知回调：后台任务或定时任务完成后会通过 `processUserInput(msg, undefined, true)` 把通知作为 `silent` 输入注入主对话。

## 会话创建

```javascript
async createSession(sessionId?: string): Promise<void>
```

执行流程根据当前状态分为两条路径：

### 路径 A：当前正在处理（processing）

```
1. 记录 pendingSession = finalSessionId（直接覆盖旧的待处理会话）
2. 调用 abortCurrentRequest() 中断当前请求
3. 等待 currentProcessingPromise 结束（最多 10 秒）
4. 若 finally 块尚未消费 pendingSession，再额外等待 100ms
5. 返回 —— 新会话由旧 processQuery 的 finally 块发起递归 createSession 创建
   （session:ready 事件由该递归调用发出）
```

### 路径 B：当前空闲

```
1. abortCurrentRequest() 清理 AbortController
2. clearPendingUserInputs()  清空旧会话的输入队列
3. pendingSession = null
4. TaskManager.dispose()      关闭所有后台进程
5. StateManager.clearAllState()
6. initialize()               设置日志级别、SessionId、检查模型配置
7. loadHistory(sessionId, workingDir)  按项目目录加载历史
8. mainAgentState.setMessageHistory / setTodos / setReadFileTimestamps
9. emit session:ready
10. mainAgentState.updateState('idle')
```

`session:ready` 事件数据：

```javascript
{
  pid: number                            // Core 进程 ID
  workingDir: string                     // 工作目录
  sessionId: string                      // 会话 ID
  historyLoaded: boolean                 // 是否恢复了历史消息
  projectInputHistory: string[]          // 项目历史输入记录
  usage: { useTokens, maxTokens, promptTokens }
  todos: TodoItem[]                      // 恢复的待办事项
  readFileTimestamps: Record<string, number>  // 文件读取时间戳
}
```


## 用户输入处理流程

```javascript
processUserInput(input: string, originalInput?: string, silent?: boolean): void
```

### 入口分流

```
1. 生成 inputId（8 位 hex）
2. 旁路：若 input 以 /quickchat 或 /quickchat 开头
   - 异步调用 handlequickchat(question)
   - 不更新状态、不入队，直接返回
3. 若当前状态为 processing
   - 根据 input 是否以 / 开头决定 type：'command' / 'inject'
   - addPendingUserInput 入队
   - emit input:received { queued: true, queueLength, inject }
   - 返回
4. 否则
   - emit input:received { queued: false, queueLength: 0 }
   - 调用 startQuery([{ inputId, input, originalInput, silent }])
```

> `silent` 输入（如后台任务完成通知）跳过 `input:received` / `input:processing` / 历史保存等用户可见行为。

### startQuery：构建上下文

```
1. updateState('processing') + emit state:update
2. 创建新的 AbortController 存入 stateManager.currentAbortController
3. 读取 coreConfig，获得 agentMode（'Agent' | 'Plan'）
4. getAvailableTools() → 内置工具 + MCP 工具，按 useTools 过滤，按模式裁剪
5. 构建 AgentContext { agentId: MAIN_AGENT_ID, abortController, tools, model: 'main' }
6. currentProcessingPromise = processQuery(inputs, agentContext, agentMode)
     .catch(...)   // 异常时清理 AbortController + 设为 idle
     .finally(...) // 清空 currentProcessingPromise 引用
```

### processQuery：执行查询

```
1. 对每条非 silent 输入 emit input:processing
2. 对每条非 silent 输入 ConfManager.saveUserInputToHistory()
3. 遍历 inputs，对每条调用 handleCommand(input)
   - 系统命令（如 /clear、/compact）→ 返回 null，跳过
   - 其它返回 { processedText, blocks }，累积到 allBlocks / combinedProcessedText
   - 每次循环前进行 abort 早期检查
4. 若 allBlocks 为空（全部为系统命令），直接返回
5. 后台启动 detectTopicInBackground（除非 disableTopicDetection）
6. processFileReferences(combinedProcessedText, agentContext)
   - 解析 @文件 / @目录 引用
   - 若有结果 → emit file:reference
7. 构建系统提示词 systemPromptContent = await formatSystemPrompt()
8. 获取消息历史 mainAgentState.getMessageHistory()
9. 构建 additionalReminders（buildAdditionalReminders）
   - 文件引用 systemReminders（每次均添加）
   - 首次查询：Todos 提醒（仅当工具集中有 Skill 时）、Rules 等
   - Plan 模式首次查询：Plan 模式专用提醒
10. createUserMessage([...additionalReminders, ...allBlocks])
11. 组合 messages = [...messageHistory, userMessage]
12. for await (const _ of query(messages, systemPromptContent, agentContext))
    → 由 Conversation 异步生成器驱动 LLM + 工具循环
```

### processQuery.finally：会话切换 & 队列消费

无论 try 块成功还是抛出（含中断异常），finally 必然执行：

```
1. 通过 setTimeout(0) 异步清空 stateManager.currentAbortController
   （避免与中断处理产生竞态）
2. 若 pendingSession 存在
   - 清空输入队列（旧会话遗留）
   - 调用 this.createSession(pendingSession)
   - 返回（不再消费输入队列）
3. 否则消费输入队列
   - consumeAllPendingInputs()
   - 通过 takeNextBatch 取出下一批
     · 'command' 类型每条单独成批
     · 'inject' 类型可批量合并
   - 剩余项放回队列
   - 若有批 → 递归 startQuery(batch)
   - 否则 updateState('idle')
```


## 工具列表构建

每次 `startQuery` 都会重新构建工具列表：

```
getAvailableTools()
   ↓
内置工具（getBuiltinTools 返回 21 个）+ MCP 工具
   ↓
按 useTools 配置过滤
   ↓
Plan 模式裁剪：移除写入类工具，保留 PlanToAgent
   ↓
返回 Tool[]
```

> 此外 `disableBackgroundTasks` 会在 schema 层面把 `run_shell` / `sub_agent` 的 `run_in_background` 字段从工具描述中移除（在 `buildTools` 中处理）。


## Agent 模式切换

```javascript
updateAgentMode(mode: 'Agent' | 'Plan'): void
```

```
1. 与当前模式比较，无变化直接返回
2. ConfManager.updateAgentMode(mode) 写入配置
3. 若新模式为 Plan → StateManager.resetPlanModeInfoSent()
   （下一次 buildAdditionalReminders 会重新发送 Plan 模式提醒）
```

如果在对话进行中（AI 调用 `PlanToAgent` 工具）切换模式，会由 `Conversation` 内部处理上下文重建信号。


## 中断

```javascript
interruptSession(): void
```

仅调用 `abortCurrentRequest()`：

```
1. 取出 stateManager.currentAbortController
2. 若存在且未 aborted，调用 abort()
3. currentAbortController = null
```

不直接更新状态为 `idle`，而是交由 `processQuery.finally` 决定：
- 若队列中仍有输入 → 继续处理
- 若 pendingSession 存在 → 切换会话
- 否则 → 设为 `idle`

队列中的待处理输入不受 `interruptSession` 影响。


## 初始化

```javascript
private async initialize(sessionId?: string): Promise<void>
```

```
1. 设置日志级别（coreConfig.logLevel）
2. 设置 sessionId（缺省自动生成）
3. 检查 main 模型
   - 若无 → emit config:no_models
   - 若加载异常 → emit session:error { type: 'model_error' }
```


## 资源释放

```javascript
dispose(): void
```

```
1. abortCurrentRequest()
2. clearPendingUserInputs() / pendingSession = null
3. StateManager.clearAllState()
4. eventBus.removeAllListeners()
```


## 事件发布

SemaEngine 直接或间接（通过 Conversation / RunTools / TaskManager）发布以下事件：

| 阶段 | 事件 |
|------|------|
| 会话就绪 | `session:ready` |
| 模型配置缺失 | `config:no_models` |
| 模型配置加载失败 | `session:error` |
| 用户输入接收 | `input:received` |
| 用户输入开始处理 | `input:processing` |
| 状态变更 | `state:update` |
| 文件引用 | `file:reference` |
| 主题检测 | `topic:update` |
| 对话消息 | `message:thinking:chunk`, `message:text:chunk`, `message:complete` |
| 工具执行 | `tool:permission:request`, `tool:execution:chunk`, `tool:execution:complete`, `tool:execution:error` |
| 子代理 | `task:agent:start`, `task:agent:end` |
| 后台任务 | `task:start`, `task:end`, `task:transfer` |
| Plan 模式 | `plan:exit:request`, `plan:implement` |
| 提问交互 | `pick:option:request` |
| 待办更新 | `todos:update` |
| Token 统计 | `conversation:usage` |
| 上下文压缩 | `compact:exec` |
| QuickChat 旁路 | `quickchat:response` |
| MCP 状态变更 | `mcp:server:status` |

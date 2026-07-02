# 管理器层

管理器层由一组进程级单例组成。单例需要按会话隔离的状态会挂在 `sessionId` 下，进程级资源仍由单例统一管理。

| 管理器 | 单例访问 | 持久化路径 | 主要职责 |
|--------|---------|-----------|---------|
| StateManager | `getStateManager()` | `~/.sema/history/<project>/` | `sessionId -> SessionRuntime` 注册表；会话内再按 `agentId` 隔离状态 |
| ConfManager | `getConfManager()` | `~/.sema/projects.conf` | 核心配置、按工作目录隔离的项目配置 |
| ModelManager | `getModelManager()` | `~/.sema/model.conf` | 模型配置、main / quick 双指针 |
| PermissionManager | 函数式 API | `~/.sema/projects.conf` 中的 `allowedTools` | 工具执行权限检查与会话级权限请求 |
| TaskManager | `getTaskManager()` | 任务记录不持久化；输出落盘到 `os.tmpdir()/sema-tasks/<taskId>.output` | RunShell / SubAgent 后台任务，按会话限流、过滤、通知 |
| CronManager | `getCronManager()` | 项目 `.sema/scheduled_tasks.json`（仅 `persist=true`）；禁用状态在 `.sema/settings.json` | 定时任务创建、执行、持久化，触发时投递到目标会话 |

## StateManager

**职责**：维护多个会话的运行时状态。

```typescript
class StateManager {
  private sessions: Map<string, SessionRuntime>
  private activeSessionId: string | null

  session(sessionId: string): SessionRuntime
  forAgent(ctx: AgentContext): AgentStateAccessor
  setActiveSession(sessionId: string): void
  getActiveSessionId(): string | null
  removeSession(sessionId: string): void
  clearAll(): void
}
```

`StateManager` 自身是注册表；真正的会话状态在 `SessionRuntime`。

### SessionRuntime

每个 `SessionRuntime` 绑定一个 `sessionId`，内部再按 `agentId` 隔离主代理与子代理状态。

#### 按 agentId 隔离

| 状态 | 类型 | 说明 |
|------|------|------|
| `statesMap` | `AgentState` | 当前运行状态，包含 `currentState` / `previousState` |
| `messageHistoryMap` | `Message[]` | 对话消息历史 |
| `todosMap` | `TodoItem[]` | 任务列表 |
| `todoTasksMap` | `TodoTask[]` | 任务详情列表（含阻塞关系） |
| `readFileTimestampsMap` | `Record<string, number>` | 文件读取时间戳（用于 `patch_file` 工具验证） |
| `fileLineEndingsMap` | `Record<string, LineEndingKind>` | 文件换行符缓存（用于 `patch_file` 工具） |

#### 会话级状态

| 状态 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 该 Runtime 绑定的会话 ID |
| `currentAbortController` | `AbortController | null` | 当前会话中断控制器 |
| `pendingUserInputs` | `PendingUserInput[]` | 该会话处理中收到的待处理输入队列 |
| `permissionLevel` | `'Ask' | 'AutoEdit' | 'AutoRun' | 'Bypass'` | 会话级权限自由度档位，仅当前会话有效 |
| `agentMode` | `'Agent' | 'Plan' | 'Design'` | 当前会话模式 |
| `systemPromptContent` | text blocks | 会话创建时冻结的系统提示快照 |
| `foregroundAgents` | `Set<string>` | 当前会话运行中的前台 Agent |

### 关键方法

```javascript
const runtime = stateManager.session(sessionId)
const agentState = runtime.forAgent(MAIN_AGENT_ID)

agentState.getMessageHistory()
agentState.setMessageHistory(messages)
agentState.finalizeMessages(messages)
agentState.flushHistory()
agentState.getCurrentState()
agentState.updateState('processing')
agentState.getTodos()
agentState.setTodos(todos)
agentState.updateTodosIntelligently(todos)
agentState.getReadFileTimestamps()
agentState.setReadFileTimestamp(filePath, ts)
agentState.getFileLineEnding(filePath)
agentState.setFileLineEnding(filePath, kind)

runtime.addPendingUserInput(item)
runtime.consumeAllPendingInputs()
runtime.clearPendingUserInputs()
runtime.getPermissionLevel()
runtime.setPermissionLevel('AutoEdit')
runtime.isAutoRun()
runtime.hasGlobalEditPermission()      // 档位非 Ask 时为 true：项目内文件编辑自动放行
runtime.grantGlobalEditPermission()    // 文件编辑 allow：仅将 Ask 提升到 AutoEdit
runtime.setSystemPromptContent(content)
runtime.getSystemPromptContent()
```

`StateManager.forAgent(ctx)` 可从 `AgentContext` 直接定位到 `sessionId + agentId` 对应的状态访问器。

### 输入队列：command vs inject

`SemaEngine.processUserInput` 在当前会话处于 `processing` 时会把新输入按类型入队：

- **command 类型**：以 `/` 开头的输入（如 `/clear`、`/compact`、自定义命令）
- **inject 类型**：普通用户消息

`/quickchat` 是例外：它在入队逻辑前旁路处理，不进入主状态机和输入队列。

`processQuery.finally` 通过 `takeNextBatch` 决定下一批：command 类型每条单独成批；inject 类型可批量合并。队列是会话级的，不会跨会话消费。

## ConfManager

**职责**：配置文件的读写与管理。内部类名为 `ConfigManager`，通过 `getConfManager()` 获取全局单例。

**持久化路径**：`~/.sema/projects.conf`

### 管理的配置

**核心配置（SemaCoreConfig）**：控制实例行为，通过 `setCoreConfig()` 初始化，通过 `updateCoreConfig()` 批量更新或 `updateCoreConfByKey()` 单字段更新。

**项目级配置（ProjectConfig）**：按工作目录分组存储：

```javascript
interface ProjectConfig {
  allowedTools: string[]
  history: string[]
  lastEditTime: string
  rules: string[]
}
```

### 关键方法

```javascript
confManager.setCoreConfig(config)
confManager.getCoreConfig()
confManager.updateCoreConfig(partialConfig)
confManager.updateCoreConfByKey(key, value)
confManager.updateUseTools(toolNames)
confManager.updateDisabledTools(toolNames)
confManager.updateAgentMode(mode)
confManager.getProjectConfig()
confManager.setProjectConfig(partialConfig)
confManager.saveUserInputToHistory(input)
```

`SemaCore.updateDisabledTools()` 是公开入口；`agentMode` 的公开运行时更新入口在 `SemaSession.updateAgentMode()`。

## ModelManager

**职责**：LLM 模型配置的持久化管理。通过 `getModelManager()` 获取全局单例。

**持久化路径**：`~/.sema/model.conf`

```javascript
{
  modelProfiles: ModelProfile[],
  modelPointers: {
    main: string,
    quick: string
  }
}
```

- `main`：用于主 Agent 的完整任务
- `quick`：用于 SubAgent 等快速任务

### 关键方法

```javascript
modelManager.addNewModel(config, skipValidation)
modelManager.deleteModel(name)
modelManager.switchCurrentModel(name)
modelManager.applyTaskModelConfig(taskConfig)
modelManager.getModel(pointer)
modelManager.getModelName(pointer)
modelManager.getModelData()
```

## PermissionManager

**职责**：工具执行前的权限检查，以及基于事件的权限请求流程。

权限请求带 `sessionId` 路由：

- `tool:permission:request` 只发送给对应会话的监听器
- `tool:permission:response` 只由对应会话处理
- 文件编辑工具的 `allow` 权限写入 `SessionRuntime`，只在当前会话生效
- `run_shell` 的持久 allow 前缀仍写入项目配置 `allowedTools`

详细的权限类型、检查流程和白名单说明参考：[权限系统](wiki/core-concepts/permission-system/overview)。

## TaskManager

**职责**：后台任务的调度与生命周期管理。覆盖 4 类调度场景：

| 场景 | 入口方法 | 说明 |
|------|---------|------|
| RunShell 后台命令 | `spawnRunShellTask` | 直接 spawn 子进程，stdout/stderr 流式落盘 |
| RunShell 超时接管 | `takeoverTask` | 接管同步 RunShell 命令的超时持久 shell 进程，继续轮询增量 |
| 前台 Agent 占位 | `registerForegroundAgent` | 前台 Agent 注册记录，可通过 `transferToBackground` 转后台 |
| Agent 后台运行 | `spawnAgentTask` | 以独立 AbortController 异步执行 LLM 子代理 |

### 关键参数

- `MAX_RUNNING_TASKS = 5`：每个会话同时运行的任务上限
- `MAX_FINISHED_TASKS = 50`：每个会话已结束任务归档上限
- `MAX_OUTPUT_BYTES = 2MB`：单任务运行中在内存保留的输出滚动上限
- 输出文件落盘目录：`os.tmpdir()/sema-tasks/<taskId>.output`

### 多会话行为

- `TaskRecord.sessionId` 记录任务归属会话
- `getTaskList(sessionId)` 只返回该会话的非前台任务
- `stopAllTasks(sessionId)` 只停止该会话的任务
- `_countRunning(sessionId)` 按会话限流
- `_pruneFinishedTasks(sessionId)` 按会话裁剪历史任务
- 任务结束后清空 `record.output` 释放内存，后续通过 `getTaskOutput(taskId)` 从输出文件读取

### 通知回调

`SemaEngine` 在构造时通过 `setNotifyCallback(sessionId, cb)` 注入回调。非前台任务完成时，TaskManager 把 `<task-notification>` 文本作为 `silent` 输入注入任务归属会话；前台 SubAgent 结果由前台流程返回，RunShell 主动停止不注入通知。

### 详细文档

- [任务管理概述](wiki/core-concepts/task-management/overview)
- [后台任务](wiki/core-concepts/task-management/background-task)
- [RunShell 后台任务](wiki/core-concepts/task-management/bash-task)
- [Agent 后台任务](wiki/core-concepts/task-management/agent-task)

## CronManager

**职责**：定时任务（Cron 表达式）的创建、调度、持久化与生命周期管理。通过 `getCronManager()` 获取全局单例。

**持久化路径**：项目目录 `.sema/scheduled_tasks.json`（仅 `persist=true` 的任务）；禁用状态写入 `.sema/settings.json` 的 `disabledCronTasks`

### 关键参数

- `MAX_TASKS = 20`：最多同时存在的定时任务
- `TICK_INTERVAL = 60_000`：检查粒度，与 cron 最小粒度一致
- `RECURRING_EXPIRE_MS = 10 * 24 * 60 * 60 * 1000`：循环任务本次激活超过 10 天后暂停调度；不删除持久化文件，下次启动会重新加载

### 多会话行为

`CronTask.sessionId` 记录创建任务的会话。触发时按以下顺序解析目标：

1. 任务有 `sessionId` 且该会话仍注册了通知回调 → 投递来源会话
2. 否则投递 UI 当前活跃会话（`StateManager.activeSessionId`）
3. 再否则取任意已注册会话兜底
4. 无目标会话则本轮跳过，下轮重试

非持久化任务在关闭来源会话时清理：

```javascript
cronManager.clearNonDurableTasks(sessionId)
```

### 关键方法

```javascript
cronManager.createTask(schedule, taskPrompt, repeat, persist, sessionId)
cronManager.getTaskList()
cronManager.deleteTask(id)
cronManager.enableTask(id)
cronManager.disableTask(id)
cronManager.clearNonDurableTasks(sessionId)
cronManager.setNotifyCallback(sessionId, cb)
cronManager.removeNotifyCallback(sessionId)
cronManager.dispose()
```

`cron:update` 是进程级事件，通过 `SemaCore.on('cron:update', ...)` 订阅。

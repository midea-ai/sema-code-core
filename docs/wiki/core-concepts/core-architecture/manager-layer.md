# 管理器层

管理器层由六个单例类组成，各自负责不同维度的状态管理，通过单例模式在整个应用生命周期内共享。

| 管理器 | 单例访问 | 持久化路径 | 主要职责 |
|--------|---------|-----------|---------|
| StateManager | `getStateManager()` | `~/.sema/history/<project>/` | 会话状态、消息历史、Todos、输入队列、文件读取时间戳 |
| ConfManager | `getConfManager()` | `~/.sema/projects.conf` | 核心配置、按工作目录隔离的项目配置 |
| ModelManager | `getModelManager()` | `~/.sema/model.conf` | 模型配置、main / quick 双指针 |
| PermissionManager | `getPermissionManager()` | 项目配置中的 `allowedTools` | 工具执行权限检查与请求 |
| TaskManager | `getTaskManager()` | `os.tmpdir()/sema-tasks/<taskId>.output` | 后台任务（RunShell / SubAgent）的调度、转后台、通知 |
| CronManager | `getCronManager()` | 项目 `.sema/scheduled_tasks.json` | 定时任务（Cron）的创建、执行、持久化 |


## StateManager

**职责**：全局会话状态管理，支持按 `agentId` 隔离的多 Agent 状态。

### 隔离状态（per agentId）

每个 Agent 独立维护：

| 状态 | 类型 | 说明 |
|------|------|------|
| `statesMap` | `'idle' \| 'processing'` | 当前运行状态（含 previousState） |
| `messageHistoryMap` | `Message[]` | 对话消息历史 |
| `todosMap` | `TodoItemWithId[]` | 任务列表 |
| `todoTasksMap` | `TodoTask[]` | 任务详情列表（含阻塞关系） |
| `readFileTimestampsMap` | `Record<string, number>` | 文件读取时间戳（用于 `patch_file` 工具验证） |
| `fileLineEndingsMap` | `Record<string, LineEndingKind>` | 文件换行符缓存（用于 `patch_file` 工具） |

### 共享状态（跨所有 Agent）

| 状态 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 当前会话 ID |
| `globalEditPermissionGranted` | `boolean` | 是否已授予全局文件编辑权限 |
| `planModeInfoSent` | `boolean` | Plan 模式提示是否已发送 |
| `currentAbortController` | `AbortController` | 当前中断控制器 |
| `pendingUserInputs` | `PendingUserInput[]` | 处理中收到的待处理用户输入队列 |

### 关键方法

```javascript
// 获取指定 Agent 的状态访问器
const agentState = stateManager.forAgent(agentId)

// AgentStateAccessor 提供的方法
agentState.getMessageHistory()                // 获取消息历史
agentState.setMessageHistory(messages)        // 设置消息历史
agentState.finalizeMessages(messages)         // 保存消息并将状态置为 idle
agentState.flushHistory()                     // 显式等待历史持久化完成
agentState.getCurrentState()                  // 获取运行状态
agentState.updateState('processing')          // 设置运行状态
agentState.getTodos()                         // 获取 Todos
agentState.setTodos(todos)                    // 设置 Todos
agentState.updateTodosIntelligently(todos)    // 智能更新 Todos
agentState.clearTodos()                       // 清理 Todos（SubAgent 专用）
agentState.getReadFileTimestamps()            // 获取全部文件时间戳
agentState.getReadFileTimestamp(filePath)     // 获取单个文件时间戳
agentState.setReadFileTimestamp(filePath, ts) // 设置单个文件时间戳
agentState.setReadFileTimestamps(map)         // 批量设置文件时间戳
agentState.getFileLineEnding(filePath)        // 获取文件换行符类型
agentState.setFileLineEnding(filePath, kind)  // 设置文件换行符类型
agentState.clearAllState()                    // 清理该 Agent 全部隔离状态（SubAgent 专用）

// TodoTask CRUD（任务详情管理）
agentState.createTodoTask(task)               // 创建任务详情
agentState.getTodoTask(taskId)                // 获取单个任务详情
agentState.listTodoTasks()                    // 获取任务详情列表
agentState.updateTodoTask(taskId, updates)    // 更新任务详情
agentState.deleteTodoTask(taskId)             // 删除任务详情
agentState.blockTask(fromId, toId)            // 建立任务阻塞关系

// 智能更新 Todos 逻辑：
// 若新 todos 均带 id 且是当前列表的子集 → 只更新匹配项
// 否则 → 完全替换

// 授予全局文件编辑权限（整个会话有效）
stateManager.grantGlobalEditPermission()
stateManager.hasGlobalEditPermission()

// 会话 ID 管理（设置时自动重置全局编辑权限）
stateManager.setSessionId(sessionId)
stateManager.getSessionId()

// Plan 模式信息发送标记
stateManager.markPlanModeInfoSent()
stateManager.isPlanModeInfoSent()
stateManager.resetPlanModeInfoSent()

// 全局清理 / 全部 Agent 状态
stateManager.clearAllState()

// 待处理用户输入队列
stateManager.addPendingUserInput(item)              // 入队（type: 'command' | 'inject'）
stateManager.getPendingUserInputsLength()
stateManager.consumeInjectInputsBeforeNextCommand() // 从队头连续取 inject，遇 command 停止
stateManager.consumeAllPendingInputs()              // 取出全部
stateManager.clearPendingUserInputs()
```

### 输入队列：command vs inject

`processUserInput` 在引擎处于 `processing` 状态时会把新输入按类型入队：

- **command 类型**：以 `/` 开头的输入（如 `/clear`、`/compact`、自定义命令）
- **inject 类型**：普通用户消息

`processQuery.finally` 通过 `takeNextBatch` 决定下一批：command 类型每条单独成批；inject 类型可批量合并。`Conversation` 在工具执行完成后还会通过 `consumeInjectInputsBeforeNextCommand` 把 inject 类输入实时注入到工具结果中（详见 [Conversation - 对话系统](wiki/core-concepts/core-architecture/conversation-system)）。

### MAIN_AGENT_ID

主 Agent 使用常量 `MAIN_AGENT_ID`（值为 `'main'`）作为 agentId，SubAgent 使用 nanoid 生成的随机 ID。

只有主 Agent 才会触发 `state:update` 和 `todos:update` 全局事件；SubAgent 的状态变更不对外广播。


## ConfManager

**职责**：配置文件的读写与管理。内部类名为 `ConfigManager`，通过 `getConfManager()` 获取全局单例。

**持久化路径**：`~/.sema/projects.conf`

### 管理的配置

**核心配置（SemaCoreConfig）**：控制实例行为，通过 `setCoreConfig()` 初始化，通过 `updateCoreConfig()` 批量更新或 `updateCoreConfByKey()` 单字段更新。

**项目级配置（ProjectConfig）**：按工作目录分组存储：

```javascript
interface ProjectConfig {
  allowedTools: string[]  // 已持久化的权限（如 'patch_file', 'run_shell(git status)'）
  history: string[]       // 输入历史（最多 30 条，倒序存储）
  lastEditTime: string    // 最近使用时间
  rules: string[]         // 项目规则
}
```

### 关键方法

```javascript
confManager.setCoreConfig(config)              // 初始化核心配置（设置工作目录、初始化项目配置）
confManager.getCoreConfig()                    // 获取核心配置副本
confManager.updateCoreConfig(partialConfig)    // 批量更新核心配置
confManager.updateCoreConfByKey(key, value)    // 更新单个核心配置字段
confManager.updateUseTools(toolNames)          // 更新可用工具过滤列表
confManager.updateAgentMode(mode)              // 切换 Agent / Plan 模式
confManager.getProjectConfig()                 // 获取当前项目配置副本
confManager.setProjectConfig(partialConfig)    // 更新项目配置并持久化
confManager.saveUserInputToHistory(input)      // 保存用户输入到历史记录
```

### 自动清理规则

- 历史记录：每个项目最多保留 **30 条**输入历史
- 项目数量：全局最多保留 **20 个**项目配置，超过时删除最久未使用的


## ModelManager

**职责**：LLM 模型配置的持久化管理。通过 `getModelManager()` 获取全局单例。

**持久化路径**：`~/.sema/model.conf`

### 数据结构

```javascript
{
  modelProfiles: ModelProfile[]      // 所有已配置模型
  modelPointers: {
    main: string                     // 主任务使用的模型名称
    quick: string                    // 快速任务使用的模型名称
  }
}
```

### 双指针设计

- `main`：用于主 Agent 的完整任务，通常选择能力最强的模型
- `quick`：用于 SubAgent 等快速任务，通常选择响应更快、成本更低的模型

当 AgentConfig 中 `model: 'main'` 时使用 `modelPointers.main` 对应的模型，`model: 'quick'` 时使用 `modelPointers.quick` 对应的模型。

### 关键方法

```javascript
modelManager.addNewModel(config, skipValidation)   // 添加模型（默认进行 API 连接校验）
modelManager.deleteModel(name)                     // 删除模型（被指针引用时禁止删除）
modelManager.switchCurrentModel(name)              // 切换 main 指针指向的模型
modelManager.applyTaskModelConfig(taskConfig)      // 同时设置 main 和 quick 指针
modelManager.getModel(pointer)                     // 获取指定指针的 ModelProfile
modelManager.getModelName(pointer)                 // 获取指定指针的模型名称
modelManager.getModelData()                        // 获取当前模型数据快照
```


## PermissionManager

**职责**：工具执行前的权限检查，以及基于事件的权限请求流程。

详细的权限类型、检查流程和白名单说明参考：[权限系统](wiki/core-concepts/tool-system/permission-system)


## TaskManager

**职责**：后台任务的调度与生命周期管理。覆盖 4 类调度场景：

| 场景 | 入口方法 | 说明 |
|------|---------|------|
| RunShell 后台命令 | `spawnRunShellTask` | 直接 spawn 子进程，stdout/stderr 流式落盘 |
| RunShell 超时接管 | `takeoverTask` | 接管同步 RunShell 命令的超时持久 shell 进程，按 200ms 轮询读取增量 |
| 前台 Agent 占位 | `registerForegroundAgent` | 前台 Agent 仅注册记录，可通过 `transferToBackground` 转后台 |
| Agent 后台运行 | `spawnAgentTask` | 直接以独立 AbortController 异步执行 LLM 子代理 |

### 关键参数

- `MAX_RUNNING_TASKS = 5`：同时运行的任务上限（超出会抛错）
- `MAX_FINISHED_TASKS = 10`：已结束任务的归档上限，超出按时间剔除
- `MAX_OUTPUT_SIZE = 2MB`：单任务输出在内存中的滚动上限
- 输出文件落盘目录：`os.tmpdir()/sema-tasks/<taskId>.output`

### 通知回调

`SemaEngine` 在构造时通过 `setNotifyCallback` 注入回调：任务结束（包括 killed）时，TaskManager 把 `<task-notification>` 文本作为 `silent` 用户输入注入主对话队列，使主代理在下一轮可以感知到后台任务结果。

### 事件

- `task:start` / `task:end` / `task:transfer`

### 详细文档

后台任务的完整流程、参数、典型代码路径与子页面：

- [后台任务概述](wiki/core-concepts/task-management/overview)
- [RunShell 后台任务](wiki/core-concepts/task-management/bash-task)
- [Agent 后台任务](wiki/core-concepts/task-management/agent-task)


## CronManager

**职责**：定时任务（Cron 表达式）的创建、调度、持久化与生命周期管理。通过 `getCronManager()` 获取全局单例。

**持久化路径**：项目目录 `.sema/scheduled_tasks.json`（仅 persist=true 的任务）

### 关键参数

- `MAX_TASKS = 20`：最多同时存在的定时任务
- `TICK_INTERVAL = 60_000`（60 秒）：检查粒度，与 cron 最小粒度一致
- `RECURRING_EXPIRE_MS = 10 * 24 * 60 * 60 * 1000`：循环任务 10 天后自动过期

### 任务类型

| 类型 | 说明 |
|------|------|
| 一次性任务（`repeat: false`）| 在下一个匹配时间点触发后自动删除 |
| 循环任务（`repeat: true`）| 按 cron 表达式重复触发，10 天后自动过期 |
| 持久化任务（`persist: true`）| 写入 `scheduled_tasks.json`，重启后恢复 |
| 会话级任务（`persist: false`）| 仅存于内存，`createSession` 时会清除 |

### 关键方法

```javascript
cronManager.createTask(schedule, taskPrompt, repeat, persist)  // 创建任务，返回任务 ID
cronManager.getTaskList()                                      // 获取任务列表
cronManager.deleteTask(id)                                     // 删除任务
cronManager.enableTask(id)                                     // 启用任务
cronManager.disableTask(id)                                    // 禁用任务
cronManager.refresh()                                          // 刷新任务列表
cronManager.clearNonDurableTasks()                             // 清除非持久化任务（createSession 时调用）
cronManager.setNotifyCallback(cb)                              // 注入通知回调（由 SemaEngine 调用）
cronManager.dispose()                                          // 清理所有定时器
```

### 通知回调

`SemaEngine` 在构造时通过 `setNotifyCallback` 注入回调：定时任务触发时，CronManager 将任务 prompt 作为 `silent` 用户输入注入主对话队列，使主代理执行预定的任务。

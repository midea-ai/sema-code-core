# 后台任务

后台任务系统由 `TaskManager`（`src/manager/TaskManager.ts`）统一调度，负责所有"脱离当前会话主对话循环、独立运行"的进程或子代理。它与会话对话之间通过事件总线 + 通知回调解耦，使主代理可以同时启动多个长耗时任务，并在后续轮次中感知到结果。

> 后台任务与 [定时任务](wiki/core-concepts/task-management/cron-task) 是任务管理的两根支柱，二者共享会话通知注入机制但职责不同，整体对比见 [任务管理概述](wiki/core-concepts/task-management/overview)。

## 在架构中的位置

```
┌──────────────┐  spawnRunShellTask / takeoverTask
│  run_shell   │ ──────────────────────────────────┐
│  工具        │                                    ▼
└──────────────┘                          ┌───────────────┐
                                          │ TaskManager   │
┌──────────────┐  spawnAgentTask /        │  (单例)       │
│  sub_agent   │  registerForegroundAgent │               │
│  工具        │ ────────────────────────►│  - tasks Map  │
└──────────────┘                          │  - watchers   │
                                          │  - notifyRegistry │
┌──────────────┐  setNotifyCallback       │               │
│  SemaEngine  │ ────────────────────────►│               │
└──────┬───────┘                          └───────┬───────┘
       │  task-notification 注入回目标会话        │
       │ ◄────────────────────────────────────────┘
       ▼
processUserInput(msg, undefined, silent=true)
       ▼
EventBus: task:start / task:end / task:transfer
```

`SemaEngine` 在构造时调用 `getTaskManager().setNotifyCallback(sessionId, cb)`，把"任务完成通知"作为 `silent` 用户输入注入当前会话队列。这样后台任务的完成不会打断当前轮次，但会在该会话下一轮自然出现在 LLM 的视野里。

## 任务记录数据结构

```typescript
interface TaskRecord {
  taskId: string                  // 8 位 hex
  sessionId?: string              // 归属会话 ID，用于多会话隔离与通知路由
  type: 'RunShell' | 'SubAgent'
  command: string                 // RunShell: shell 命令文本；SubAgent: 描述/title
  toolUseId: string               // 触发该任务的 tool_use id
  filepath: string                // 输出文件绝对路径
  status: 'running' | 'completed' | 'failed' | 'killed'
  output: string                  // 运行中的滚动输出（受 MAX_OUTPUT_BYTES 限制；结束后清空）
  pid?: number
  exitCode?: number
  foreground?: boolean            // 仅 SubAgent 使用：是否是前台 Agent
  agentType?: string              // SubAgent 子代理类型
  startTime: number
  endTime?: number
  usage?: { totalTokens; toolUses; durationMs }   // 仅 SubAgent

  // 内部字段（不对外暴露）
  _process?: ChildProcess         // spawnRunShellTask 的子进程
  _shellProcess?: ChildProcess    // takeoverTask 接管的旧 shell
  _pollTimer?: NodeJS.Timeout     // takeoverTask 的轮询定时器
  _abortController?: AbortController  // SubAgent 的独立中断器
  _unlinkAbort?: () => void       // 解除前台 SubAgent 与主 AC 联动的回调
  _transferResolve?: () => void   // 转后台时唤醒 Promise.race 的 resolve
  _promise?: Promise<void>
}
```

`getTaskList()` 返回的 `TaskListItem[]` 仅包含**非前台**任务（前台 SubAgent 仍占用一个 slot 但不在列表中，避免 UI 误以为有"游离"任务）。

## 关键参数

| 常量 | 值 | 含义 |
|------|----|------|
| `MAX_RUNNING_TASKS` | 5 | 每个会话同时 running 的任务上限。超出时对应方法会抛错（按会话独立计算，避免某个会话占满名额） |
| `MAX_FINISHED_TASKS` | 50 | 每个会话已结束任务的归档数量，超出时按时间剔除（按会话分组裁剪，避免跨会话相互影响） |
| `MAX_OUTPUT_BYTES` | 2 MB | 单任务在内存中保留的输出滚动上限，达到后保留尾部 |
| `TASK_OUTPUT_DIR` | `os.tmpdir()/sema-tasks/` | 输出文件落盘目录，每个任务一个 `<taskId>.output` 文件 |

> 后台任务限额按会话独立计算：`_countRunning(sessionId)` 统计指定会话正在运行的任务数。`_pruneFinishedTasks(sessionId)` 按会话分组裁剪已结束任务。

> `disableBackgroundTasks` 配置（核心配置）会在 `buildTools` 中把 `run_shell` / `sub_agent` 工具 schema 里的 `background` 字段过滤掉，从而在 LLM 层面禁用后台任务能力。

## 流式输出与订阅模型

```javascript
// UI 打开任务详情面板时调用：
const unwatch = taskManager.watchTask(taskId, (delta: string) => {
  panel.append(delta)
})

// UI 关闭面板时调用：
unwatch()
```

- `watchTask` 立即补发已有输出：运行中任务读取 `record.output`，已结束任务通过 `getTaskOutput(taskId)` 读取输出文件；之后通过内部 `_notifyWatchers` 推送增量
- 多个 watcher 可同时订阅同一任务
- 任务结束（`_finishTask`）时自动清理该任务的 watchers
> 任务结束后 `record.output` 会被清空（输出已落盘到文件），后续读取通过 `getTaskOutput(taskId)` 方法：运行中任务返回内存缓存，已结束任务自动回退读取输出文件。`PeekBgJob` 工具也改用此方法获取输出。

`waitForTask(taskId, timeout, onChunk?, abortSignal?)` 是一个等待型 API，监听 `task:end` 事件直至任务结束或超时返回当前 `TaskRecord`。常用于工具内部"等待后台任务完成"的场景。

## 事件

| 事件 | 触发时机 | 主要字段 |
|------|---------|---------|
| `task:start` | `spawnRunShellTask` / `takeoverTask` / `spawnAgentTask` 创建任务时 | `taskId, pid?, command, filepath, status, type, agentType?` |
| `task:end` | `_finishTask` / `stopTask` / `dispose` | `taskId, status, summary` |
| `task:transfer` | `transferToBackground` 把前台 SubAgent 转后台 | `taskId, command, filepath, status, type, agentType?` |

> 注意：子代理（无论前台/后台）还会触发 `task:agent:start` / `task:agent:end`，那是 `sub_agent` 工具自身发出的"子代理生命周期"事件，与这里的"任务记录"事件来源不同（详见 [Agent 后台任务](wiki/core-concepts/task-management/agent-task)）。

## 通知回调（注入目标会话）

任务结束（含 `killed`）时，`_notify` 会按 `record.sessionId` 找到对应的通知回调，构造一段 `<task-notification>` 文本并注入该会话。`SemaEngine` 把它作为 `silent` 输入入队：

```
TaskManager._notify(record)
   ↓
notifyRegistry.get(record.sessionId)(msg)
   ↓
SemaEngine.processUserInput(msg, undefined, silent=true)
   ↓
若 processing → 入队为 inject 类型
若 idle      → 立即 startQuery
```

通知文本中包含 `taskId`、`tool-use-id`、`status`、`summary`、`result`/`output-file` 等字段，使 LLM 在下一轮可以准确引用并决定后续动作。具体格式见两个子页面。

> 前台 SubAgent **正常完成**时不发送通知（结果由 `SubAgent.ts` 直接 yield 回到当前对话）；只有「后台 SubAgent」或「中途被 stop 的后台 SubAgent」才会触发 `_notify`。

## 公开 API（SemaSession 暴露）

```javascript
session.getTaskList(): TaskListItem[]
session.watchTask(taskId, onDelta): () => void
session.stopTask(taskId): boolean
session.stopAllTasks(): number
session.transferAgentToBackground(taskId): boolean
session.transferAllForegroundAgents(): string[]
```

这些 API 由 `SemaSession` 暴露。`getTaskList()`、`stopAllTasks()`、`transferAllForegroundAgents()` 会按当前 `sessionId` 过滤；`watchTask(taskId)`、`stopTask(taskId)`、`transferAgentToBackground(taskId)` 直接按 `taskId` 操作。`SemaSession.dispose()` 会调用 `getTaskManager().disposeSession(sessionId)`：停止该会话 running 任务、删除该会话任务记录和 watcher；`SemaCore.dispose()` 才会释放所有会话和全局任务资源。

## 子页面

- [RunShell 后台任务](wiki/core-concepts/task-management/bash-task) — `spawnRunShellTask` / `takeoverTask` 与子进程模型
- [Agent 后台任务](wiki/core-concepts/task-management/agent-task) — 前台/后台 SubAgent 与转后台机制

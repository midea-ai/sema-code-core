# RunShell 后台任务

RunShell 后台任务由 `run_shell` 工具（`src/tools/RunShell.ts`）与 `TaskManager` 协作实现，分两条入口路径：

1. **主动后台**：LLM 调用 `run_shell` 工具时显式传入 `background: true`
2. **超时接管**：同步执行的 shell 命令超过 `timeout` 时，自动接管底层持久 shell 进程并转为后台任务

两种路径最终都会在 `TaskManager.tasks` 中创建一条 `type: 'RunShell'` 的记录。

## 触发约束

- 仅主代理（`agentId === MAIN_AGENT_ID`）允许后台任务，子代理强制前台
- 核心配置 `disableBackgroundTasks: true` 时：
  - `buildTools` 会从 `run_shell` 的 schema 中过滤 `background` 字段
  - 即便 LLM 强行传入也会被忽略（子代理 / disableBackground 分支直接跳过）
  - 超时处理 `onTimeout` 回调不再注册，超时直接 kill
- `MAX_RUNNING_TASKS = 5` 限流：按会话独立计算，超出时 `spawnRunShellTask` / `takeoverTask` 抛错

## 路径一：主动后台 spawnRunShellTask

调用链：

```
run_shell 工具 (background: true)
   │
   ▼
TaskManager.spawnRunShellTask(command, toolUseId, agentContext)
   │
   ├─ 检查当前会话的 MAX_RUNNING_TASKS
   ├─ ensureTaskDir() + 生成 taskId（4 字节 hex）
   ├─ 初始化输出文件 <tmpdir>/sema-tasks/<taskId>.output
   ├─ 创建 TaskRecord（type: 'RunShell', sessionId, status: 'running'）
   ├─ spawn 子进程（getShellForSpawn 返回的一次性 shell + 命令字符串）
   │     cwd: readInitialCwd()
   │     stdio: ['ignore', 'pipe', 'pipe']
   │     Windows: windowsHide: true
   ├─ emit task:start { taskId, pid, command, filepath, status, type: 'RunShell' }（按 sessionId 路由）
   │
   ├─ stdout/stderr 'data' 监听 → appendChunk
   │     ├─ 累加到 record.output（受 MAX_OUTPUT_BYTES 滚动限制）
   │     ├─ fs.appendFileSync 落盘
   │     └─ _notifyWatchers 推送增量给所有 watchers
   │
   ├─ 'exit' 事件 → _finishTask(record, exitCode ?? 1)
   └─ 'error' 事件 → 追加 [Process error: ...] + _finishTask(record, 1)
```

工具的返回值：

```
Command running in background. Task ID: <taskId>. Output: <filepath>
```

LLM 在下一轮可以通过 `peek_bg_job` 工具或 `<task-notification>` 通知拿到结果。

## 路径二：超时接管 takeoverTask

主代理在前台执行 shell 命令时，`PersistentShell.exec` 接受 `onTimeout` 回调。当命令运行超出 `timeout` 时（默认 `DEFAULT_RUN_SHELL_TIMEOUT_MS = 120000`，最大 `RUN_SHELL_MAX_TIMEOUT_MS = 600000`），`onTimeout` 被触发：

```javascript
const onTimeout = (isSubAgent || disableBackground) ? undefined : (ctx: TimeoutTransferContext) => {
  const result = getTaskManager().takeoverTask(
    ctx, command, currentToolUseID, agentContext,
  )
  bgTaskId = result.taskId
  bgFilepath = result.filepath
}
```

`TimeoutTransferContext` 包含：

| 字段 | 含义 |
|------|------|
| `shellProcess` | 仍在运行的持久 shell 进程对象 |
| `partialOutput` | 已收集的输出（拼接好的 stdout+stderr） |
| `stdoutFile` / `stderrFile` | shell 写入的临时文件路径 |
| `statusFile` | 命令完成后写入退出码的文件路径 |

`takeoverTask` 的执行流程：

```
1. 检查当前会话的 MAX_RUNNING_TASKS（超出 → killProcess(shellProcess) 后抛错）
2. 生成 taskId / filepath，把 partialOutput 写入新输出文件
3. 创建 TaskRecord（type: 'RunShell', sessionId, _shellProcess: ctx.shellProcess）
4. emit task:start { taskId, pid, command, filepath, status, type: 'RunShell' }（按 sessionId 路由）
5. setInterval 200ms 轮询：
   ├─ 增量读取 stdoutFile / stderrFile（按 stdoutOffset / stderrOffset 偏移）
   │     → 追加到 record.output + 输出文件 + 通知 watchers
   ├─ 检测 statusFile 非空 → 命令正常完成
   │     → 读完最后一段输出（防止 shell exit handler 删文件）
   │     → killProcess(shellProcess)
   │     → _finishTask(record, exitCode)
   └─ 检测 shellProcess.exitCode 非 null（异常退出且无 statusFile）
         → _finishTask(record, exitCode ?? 1)
```

主代理工具调用的返回值：

```
Command timed out after <duration>, moved to background.
Task ID: <bgTaskId>.
Output: <bgFilepath>
```

> 这条路径的优势是用户/LLM 不会因为某条同步命令"卡住"主对话——它会自动变成后台任务，主代理可以继续做别的事。

## 完成与清理

`_finishTask(record, exitCode)`：

1. 状态从 `running` 切到 `completed`（exit=0）或 `failed`（其它）
2. 记录 `exitCode` / `endTime`
3. 删除该任务的 watchers（避免后续无用回调）
4. emit `task:end { taskId, status, summary }`（按 sessionId 路由）
5. `if (!record.foreground)` → 调用 `_notify(record)`（RunShell 任务的 `foreground` 始终为 undefined/falsy，故总会通知）
6. 清空 `record.output` 释放内存，后续读取通过 `getTaskOutput(taskId)` 回退到输出文件
7. `_pruneFinishedTasks(record.sessionId)` 按会话分组裁剪已结束任务到 `MAX_FINISHED_TASKS`

`stopTask(taskId)`：

1. 清理 `_pollTimer`（如果是接管任务）
2. `killProcess(_process)` 或 `killProcess(_shellProcess)`
3. 状态置为 `killed`，emit `task:end`
4. **RunShell 任务不在 stopTask 中调用 `_notify`**（只有 SubAgent 的 stopTask 会发通知）

## 通知格式

RunShell 任务的通知文本（由 `TaskManager._notify` 发出）：

```
[task-notification] task_id=<taskId> tool_use_id=<toolUseId> status=<status>
- summary: Background shell command <status> (exit code <exitCode>)
- output_file: <filepath>
To retrieve the result, read the output file: <filepath>
```

LLM 看到通知后，通常会主动调用 `read` 或 `peek_bg_job` 工具去读 `filepath`，从而获得完整命令输出。

## 用户操作 API

```javascript
// 列表（仅含非前台任务）
session.getTaskList()

// 流式订阅输出（UI 打开任务详情面板时）
const unwatch = session.watchTask(taskId, delta => panel.append(delta))
// 关闭面板时
unwatch()

// 停止
session.stopTask(taskId)
session.stopAllTasks()
```

## 与 peek_bg_job / stop_bg_job 内置工具的关系

LLM 自身可以通过两个工具与后台任务交互：

- **peek_bg_job**：通过 `TaskManager.getTaskOutput(taskId)` 获取输出；运行中读取内存缓存，已结束任务读取输出文件
- **stop_bg_job**：调用 `stopTask(taskId)` 主动停止后台任务

它们封装的就是 `TaskManager` 的同名能力，因此 LLM 不需要直接 `read` 输出文件。

# 后台任务使用

Sema Core 支持将耗时的 Shell 命令和 SubAgent 任务放到后台运行，当前会话主代理不被阻塞。后台任务完成后，通知会注入任务归属会话，主代理在后续轮次中自动收到。

## 三种后台任务路径

| 路径 | 触发方式 | 完成通知 |
|------|---------|---------|
| **显式后台** | `run_shell` 或 `sub_agent` 工具传入 `background: true` | `<task-notification>`，RunShell 含输出文件路径，SubAgent 含完整结果 |
| **超时接管** | `run_shell` 同步命令超时后自动接管 | `<task-notification>` 含输出文件路径 |
| **前台转后台** | 用户调用 `transferAgentToBackground()` | `<task-notification>` 含完整结果与 token/tool_uses 统计 |

> 任务结束后，TaskManager 通过 `setNotifyCallback(sessionId, cb)` 注册的回调将通知作为 silent 输入注入任务归属会话的输入队列。

## 限流与配置

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `MAX_RUNNING_TASKS` | 5 | 每个会话同时运行的任务上限（含前台 Agent） |
| `MAX_FINISHED_TASKS` | 50 | 每个会话已结束任务的归档上限 |
| `MAX_OUTPUT_BYTES` | 2 MB（即 `2 * 1024 * 1024`） | 单任务运行中在内存里的滚动输出上限，任务结束后释放内存 |
| 输出目录 | `os.tmpdir()/sema-tasks/` | 每个任务一个 `<taskId>.output` 文件 |

### 关闭后台任务

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/project',
  disableBackgroundTasks: true,
})
```

设置后：
- `run_shell` 工具的 `background` 参数从 schema 中过滤，LLM 看不到
- `sub_agent` 工具的 `background` 参数同样被过滤
- 超时命令不再接管到后台，直接 kill
- 可通过 `sema.updateCoreConfByKey('disableBackgroundTasks', true)` 动态切换

## LLM 如何触发后台任务

后台任务由 LLM 自主决定何时开启。当 LLM 调用工具时传入 `background: true`，工具会立即返回一段说明：

**run_shell 显式后台：**
```
Command running in background. Task ID: <taskId>. Output: <filepath>
```

**sub_agent 显式后台：**
```
Async agent launched successfully. agentId: <taskId> ...
```

**run_shell 超时接管：**
```
Command timed out after <duration>, moved to background.
Task ID: <taskId>.
Output: <filepath>
```

**sub_agent 前台转后台：**
```
Agent moved to background.
agentId: <taskId>
It will continue running independently. You will be notified when it finishes.
```

当前会话主代理可继续处理其它请求；任务完成后后续轮次会自动看到通知。

> 想引导 LLM 多用后台任务，可以在 `customRules` 或 `AGENTS.md` 中加一句："对于预计超过 30 秒的命令优先放到后台运行"。

## LLM 工具：peek_bg_job 与 stop_bg_job

后台任务启动后，LLM 可以通过两个内置工具与它们交互：

### peek_bg_job — 查看后台任务输出

```javascript
// 参数
{
  job_id: string,            // 后台任务 ID
  wait?: boolean,            // 默认 true：等待任务完成再返回；false：立即返回当前快照
  wait_timeout?: number,     // 默认 30000ms（30 秒），等待超时
}

// 返回值
{
  taskId: string,
  retrievalStatus: 'completed' | 'timeout' | 'not_ready' | 'not_found',
  taskStatus: 'running' | 'completed' | 'failed' | 'killed',
  taskType: 'RunShell' | 'SubAgent',
  output: string,            // 截断后的输出内容
}
```

- `wait=true`（默认）：阻塞等待任务完成，RunShell 任务会流式推送增量输出
- `wait=false`：立即返回当前已捕获的输出快照
- 等待可被当前会话主代理的中断信号（AbortSignal）中止，此时 `retrievalStatus` 为 `'not_ready'`

### stop_bg_job — 停止后台任务

```javascript
// 参数
{ job_id: string }

// 返回值
{
  taskId: string,
  message: string,
  taskType: string,
  command: string,
  stopped: boolean,
}
```

停止方式根据任务类型：
- **RunShell 任务**：`killProcess` 终止子进程和接管进程
- **SubAgent 任务**：`AbortController.abort()` 中止执行

## 用户操作 API

```javascript
// 列出当前会话的后台任务（不含前台 Agent）
const list = session.getTaskList()
// 返回 TaskListItem[]：{ taskId, pid?, filepath, status, type, command, agentType?, foreground?, startTime, endTime? }
list.forEach(t => {
  console.log(`[${t.taskId}] ${t.type} ${t.status} ${t.command}`)
})

// 流式订阅某个任务的输出（UI 打开任务面板时）
// 调用时立即补发已有输出，后续增量实时推送
const unwatch = session.watchTask(taskId, (delta) => {
  process.stdout.write(delta)
})
// 关闭面板时取消订阅
unwatch()

// 停止任务
session.stopTask(taskId)       // 返回 boolean：是否成功
session.stopAllTasks()         // 返回 number：停止的任务数

// 把运行中的前台 Agent 转为后台
session.transferAgentToBackground(taskId)   // 返回 boolean
session.transferAllForegroundAgents()       // 返回 string[]：被转移的任务 ID 列表
```

### transferToBackground 内部流程

1. 解除子 Agent 的 AbortController 与主 AC 的联动（`_unlinkAbort`）
2. 调用 `_transferResolve`，使 `Agent.ts` 中 `Promise.race` 立刻返回
3. 标记 `foreground = false`
4. 发出 `task:transfer` 事件

## 事件

```javascript
// 任务启动
session.on('task:start', ({ taskId, pid, command, filepath, status, type, agentType }) => {
  console.log(`后台任务启动: ${taskId} (${type})`)
  // RunShell 类型含 pid，SubAgent 类型含 agentType
})

// 任务结束
session.on('task:end', ({ taskId, status, summary }) => {
  // status: 'completed' | 'failed' | 'killed'
  console.log(`后台任务结束: ${taskId} → ${status}: ${summary}`)
})

// 前台转后台
session.on('task:transfer', ({ taskId, from, to }) => {
  // from: 'foreground', to: 'background'
  console.log(`任务转移: ${taskId} ${from} → ${to}`)
})

// SubAgent 任务启动（含 background 字段标识前后台）
session.on('task:agent:start', ({ taskId, agent_type, title, instructions, background }) => {
  console.log(`Agent 启动: ${taskId} (${agent_type}) background=${background}`)
})
```

## 典型场景

### 1. 用户在 UI 上把"耗时较长的探索"转后台

```javascript
// 用户点击 UI 上的"转后台"按钮
session.transferAgentToBackground(currentForegroundTaskId)
// → 当前会话主对话立刻回到 idle，可继续接收用户输入
// → 子代理在后台继续执行，完成后自动注入 task-notification
```

### 2. 后台任务面板

```javascript
function renderTaskPanel() {
  const tasks = session.getTaskList()
  return tasks.map(t => ({
    id: t.taskId,
    type: t.type,
    cmd: t.command,
    status: t.status,
    agentType: t.agentType,
    foreground: t.foreground,
    duration: (t.endTime ?? Date.now()) - t.startTime,
  }))
}

session.on('task:start', renderTaskPanel)
session.on('task:end',   renderTaskPanel)
```

### 3. 流式查看长跑命令

```javascript
const taskId = 'xxxx'   // 来自 task:start 事件
const unwatch = session.watchTask(taskId, delta => panel.append(delta))

// 任务结束时取消订阅
session.once('task:end', (e) => {
  if (e.taskId === taskId) unwatch()
})
```

## 任务通知格式

后台任务完成后，TaskManager 通过当前任务 `sessionId` 对应的通知回调生成通知消息并注入该会话：

**RunShell 任务通知：**
```
[task-notification] task_id=<taskId> tool_use_id=<toolUseId> status=<status>
- summary: Background shell command <status> (exit code <exitCode>)
- output_file: <filepath>
To retrieve the result, read the output file: <filepath>
```

**SubAgent 任务通知：**
```
[task-notification] task_id=<taskId> tool_use_id=<toolUseId> status=<status>
- summary: Agent "<title>" <status>
- tokens: <totalTokens>, tool_uses: <toolUses>, duration: <durationMs>ms
- result:
<output>
```

## 默认超时

`run_shell` 命令的默认超时为 **120000ms（2 分钟）**，可通过 `timeout` 参数调整，最大 **600000ms（10 分钟）**。

## 主要限制

- **子代理不允许嵌套后台任务**：SubAgent 内部调用 `run_shell` 时，`background` 字段被 `.omit({ background: true })` 移除，LLM 不可见；超时命令也不接管，直接 kill
- **关闭会话会清理本会话任务**：`core.closeSession(sessionId)` / `session.dispose()` 会停止并清理该会话的任务；创建新会话不会自动清空其它会话任务
- **前台 Agent 不在 `getTaskList()` 中**：前台 Agent 仍占用当前会话一个 `MAX_RUNNING_TASKS` 名额，但 `getTaskList()` 中 `filter(t => !t.foreground)` 将其过滤，避免 UI 误以为有"游离"任务
- **后台任务数上限**：当前会话达到 `MAX_RUNNING_TASKS` (5) 时，新后台任务会抛出 Error；超时接管场景会 kill 超时进程并抛错

## 进一步了解

后台任务的完整调度模型、`TaskRecord` 数据结构、超时接管机制、前后台 Agent 的 `Promise.race` 协作流程：

- [后台任务](wiki/core-concepts/task-management/background-task)
- [RunShell 后台任务](wiki/core-concepts/task-management/bash-task)
- [Agent 后台任务](wiki/core-concepts/task-management/agent-task)

# SubAgent 后台任务

SubAgent 后台任务由 `sub_agent` 工具（`src/tools/SubAgent.ts`）与 `TaskManager` 协作实现。SubAgent 任务的特殊性在于：它不是一个独立的 OS 进程，而是一段在主进程中运行的 LLM 子代理逻辑（`query()` 异步生成器循环），通过独立的 `AbortController` 实现"软中断"。

## 三种执行模式

| 模式 | 触发 | TaskManager 调用 | 是否占用主对话 |
|------|------|------------------|--------------|
| 前台 SubAgent | `sub_agent` 工具 `background: false`（默认）| `registerForegroundAgent` | 主对话等待结果 |
| 后台 SubAgent | `sub_agent` 工具 `background: true` | `spawnAgentTask` | 主对话立即返回 |
| 转后台 SubAgent | 前台 SubAgent 运行中调用 `transferAgentToBackground(taskId)` | `transferToBackground` | 由前台变后台 |

> 子代理中会排除部分工具（`SUBAGENT_EXCLUDED_TOOLS`：含 `sub_agent`、`peek_bg_job`、`stop_bg_job`、`ask_form`、`plan_to_agent`、`create_todo`、`get_todo`），防止嵌套调用；子代理的 `run_shell` 工具也会 omit 掉 `background` 字段。`disableBackgroundTasks: true` 时还会跳过 `spawnAgentTask` 与 `setTransferResolve`，从根本上禁用后台模式。

## 路径一：直接后台 spawnAgentTask

LLM 调用 `sub_agent` 工具时传 `background: true`：

```
sub_agent 工具
   │
   ├─ 构建 subagentTools / systemPrompt / userMessage
   ├─ emit task:agent:start { taskId, agent_type, title, instructions, background: true }
   │
   ▼
TaskManager.spawnAgentTask(taskId, title, toolUseId, executeFn, agentConfig.name)
   │
   ├─ 检查 MAX_RUNNING_TASKS
   ├─ 创建独立 AbortController（与主代理 AC 完全无联动）
   ├─ ensureTaskDir() + 创建空输出文件
   ├─ 创建 TaskRecord（type: 'SubAgent', _abortController, agentType）
   ├─ emit task:start { taskId, command: description, filepath: '', status, type: 'SubAgent', agentType }
   │
   ├─ executeFn(bgAbortController) 异步执行
   │     for await (const message of query(...)) { 收集 }
   │     ├─ 成功：return { result, usage: { totalTokens, toolUses, durationMs } }
   │     ├─ 失败/中断：throw（错误沿 Promise 链传递）
   │     └─ 任意分支 finally：stateManager.forAgent(taskId).clearAllState()
   │
   └─ Promise.then / catch：
        ├─ 成功 → record.output = result + 写入 filepath + _finishTask(0)
        └─ 失败 → 写入 [Agent interrupted] 或 [Agent error: ...] + _finishTask(0/1)
```

工具立即返回（不等待 executeFn）：

```
Background agent started.
agentId: <taskId> (internal ID — do not share with user)
It is running independently. You will be notified when it finishes.
Do not overlap with this agent's work...
```

主代理可继续处理其它工作。后台 SubAgent 完成时通过 `_notify` 注入主对话。

## 路径二：前台 SubAgent + 可选转后台

前台 SubAgent 是 `sub_agent` 工具的默认行为：

### 1. 共享 / 独立 AbortController 联动

```javascript
const sharedAbortController = stateManager.currentAbortController  // 主代理 AC
const subAbortController  = new AbortController()                   // 子代理独立 AC

// 主 AC abort → 子 AC abort
const onMainAbort = () => subAbortController.abort()
sharedAbortController.signal.addEventListener('abort', onMainAbort)
const unlinkAbort = () => {
  sharedAbortController.signal.removeEventListener('abort', onMainAbort)
}

// 如果主 AC 已经 abort 了，立刻 abort 子 AC
if (sharedAbortController.signal.aborted) {
  subAbortController.abort()
}
```

`unlinkAbort` 是后续转后台的关键 —— 解除联动后，主 AC 再 abort 也不会影响子代理。

### 2. 注册前台占位

```javascript
taskManager.registerForegroundAgent(
  taskId, title, toolUseId, subAbortController, unlinkAbort, agentConfig.name,
)
stateManager.addForegroundAgent(taskId)
```

前台 SubAgent 在 `tasks` Map 中创建一条 `foreground: true` 的记录，**不出现在 `getTaskList()` 中**（避免 UI 误以为有"游离"任务），但会占用一个 `MAX_RUNNING_TASKS` 名额。

### 3. Promise.race：等结果 vs 等转后台

```javascript
const transferSignal = new Promise<void>(resolve => {
  transferResolve = resolve
})
if (!disableBackground) {
  taskManager.setTransferResolve(taskId, transferResolve!)
}

const completionPromise = executionPromise.then(
  res => ({ type: 'completed', res }),
  err => ({ type: 'error', err })
)

const raceResult = await Promise.race([
  completionPromise,                                   // 子代理执行完成
  transferSignal.then(() => ({ type: 'transferred' })) // 被转后台
])
```

三种 race 结果：

| 结果 | 处理 |
|------|------|
| `completed` | `taskManager.finalizeTask(taskId, 0, result, usage)`，工具 yield 完整结果给主对话 |
| `error` | 中断 → `finalizeTask(taskId, 0)`，否则 `finalizeTask(taskId, 1)`，工具 yield 摘要/错误信息 |
| `transferred` | executionPromise 继续在后台跑，工具立即返回。完成回调挂在 `record._promise` 上：成功写入 `filepath` 并 `finalizeTask(0)`；失败则写入错误信息并 `finalizeTask(0/1)` |

### 4. 转后台 transferToBackground

`SemaCore.transferAgentToBackground(taskId)` → `TaskManager.transferToBackground(taskId)`：

```
1. 校验：record 存在 + foreground === true + status === 'running'
2. 调用 record._unlinkAbort()  // 解除主/子 AC 联动
3. record.foreground = false
4. record._transferResolve()    // 唤醒 SubAgent.ts 中的 Promise.race
5. emit task:transfer { taskId, from: 'foreground', to: 'background' }
```

`transferAllForeground()` 是批量版本，遍历所有 `foreground && running` 的 record 依次调用 `transferToBackground`。

### 5. finalizeTask：统一收尾

`SubAgent.ts` 在三种 race 结果中都会调用 `taskManager.finalizeTask(taskId, exitCode, output?, usage?)`：

```javascript
finalizeTask(taskId, exitCode, output?, usage?) {
  if (record.status !== 'running') return       // 重入保护
  if (output) record.output = output
  if (usage)  record.usage  = usage
  this._finishTask(record, exitCode)            // → emit task:end + 通知（仅非前台）
}
```

> `stateManager.removeForegroundAgent(taskId)` 在 `executionPromise` 的 `finally` 块中调用，确保无论前台完成还是转后台结束都会清理状态。

`_finishTask` 内部判断：**前台任务不发通知**（结果由 `SubAgent.ts` 直接 yield 回主对话）；只有"转后台后完成"或"直接 spawnAgentTask"的任务才会触发 `_notify`。

## 中断行为

| 入口 | 实际效果 |
|------|---------|
| `interruptSession()` | 主 AC abort → 联动到前台子 AC → 子代理在最近的检查点中止；后台 SubAgent **不受影响** |
| `stopTask(taskId)` | 直接 `record._abortController.abort()`，无论前/后台都会中止；同时 emit `task:end` 与（后台任务的）通知 |
| `dispose()` | 杀掉所有 running 任务（含 abort 所有 SubAgent），清空 `tasks` 与 `watchers` |

## 通知格式

SubAgent 任务的通知文本（仅"非前台"任务由 `TaskManager._notify` 发出）：

```
[task-notification] task_id=<taskId> tool_use_id=<toolUseId> status=<status>
- summary: Agent "<description>" <status>
- tokens: <totalTokens>, tool_uses: <toolUses>, duration: <durationMs>ms
- result:
<完整 output>
```

> 与 RunShell 任务不同，SubAgent 通知直接携带完整 `<result>`，主代理无需再读输出文件。

## 与 task:agent:* 事件的区别

`sub_agent` 工具自身在子代理生命周期内会发出：

- `task:agent:start { taskId, agent_type, title, instructions, background }`
- `task:agent:end { taskId, status, content }`

而 `TaskManager` 发出的是：

- `task:start { taskId, command, filepath, status, type: 'SubAgent', agentType }`
- `task:end { taskId, status, summary }`
- `task:transfer { taskId, from, to }`

两组事件**同源但不同视角**：

- `task:agent:*` 关注的是"LLM 子代理的对话生命周期"，由 `SubAgent.ts` 主动发出，无论前台/后台都触发，包含完整 title/instructions
- `task:*` 关注的是"被 TaskManager 调度的任务生命周期"，包含进程/输出/转后台等基础设施信息

UI 通常订阅 `task:agent:*` 显示"子代理执行中"卡片，订阅 `task:*` 维护"后台任务面板"。

## 用户操作 API

```javascript
sema.getTaskList()                       // 不含前台 SubAgent
sema.watchTask(taskId, onDelta)          // SubAgent 任务的 output 一般在结束时一次性写入
sema.stopTask(taskId)                    // 中止任意运行中的 SubAgent
sema.transferAgentToBackground(taskId)   // 把单个前台 SubAgent 转后台
sema.transferAllForegroundAgents()       // 把所有前台 SubAgent 批量转后台
```

典型场景：用户在 UI 上看到主代理调起了一个耗时较长的子代理，决定让它"在后台跑"，主对话立刻回到 idle —— 这就是 `transferAgentToBackground` 的目标用法。

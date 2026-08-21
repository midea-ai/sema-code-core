# 定时任务

定时任务系统由 `CronManager`（`src/manager/CronManager.ts`）以单例形式统一调度，负责所有"按时间表反复或一次性触发、到点把指令注入目标会话"的任务。它与 [后台任务](wiki/core-concepts/task-management/background-task) 都通过 `SessionNotifyRegistry` + 通知回调与会话解耦，但二者职责不同：后台任务关注"脱离主循环独立运行的进程/子代理"，定时任务关注"按 cron 时间表唤起一轮新的对话"。整体定位见 [任务管理概述](wiki/core-concepts/task-management/overview)。

## 在架构中的位置

```
┌──────────────┐  create_cron / list_crons / del_cron
│  cron 工具    │ ──────────────────────────────────┐
└──────────────┘                                    ▼
                                          ┌───────────────────┐
┌──────────────┐  setNotifyCallback       │  CronManager      │
│  SemaEngine  │ ────────────────────────►│   (单例)          │
└──────┬───────┘                          │  - tasks Map      │
       │                                  │  - timer (60s)    │
       │  cron-notification 注入目标会话   │  - notifyRegistry │
       │ ◄────────────────────────────────┤  - tick()         │
       ▼                                  └─────────┬─────────┘
processUserInput(msg, task.task,                    │ tick 每 60s 扫描
                 source='cron')            到点 → resolveTarget → fire
```

`SemaEngine` 在构造时调用 `getCronManager().setNotifyCallback(sessionId, cb)`，把"定时任务触发"作为 `source='cron'` 的用户输入注入会话队列：UI 将其渲染为带"定时任务"标签的用户消息（气泡显示干净的任务文本，模型收到完整通知消息），但不进上翻输入历史、不触发 UserPromptSubmit hook、不参与话题检测。会话忙时入队、空闲时立即起一轮，因此 cron 触发不会打断当前轮次。

## 任务数据结构

```typescript
interface CronTask {
  id: string                 // 8 位 hex
  sessionId?: string         // 创建该任务的会话 ID（触发时优先注入该会话）
  schedule: string           // 5 字段 cron 表达式（用户本地时间）
  task: string               // 触发时执行的提示词/指令
  repeat: boolean            // true=周期执行；false=一次性触发后删除
  persist: boolean           // true=持久化到文件；false=仅内存
  status: boolean            // true=启用；false=禁用
  filePath?: string          // 持久化文件路径
  createdAt: number
  describeCronExpression: string  // 人类可读的 cron 描述
  activatedAt: number        // 本轮调度起始时间，用于 10 天过期判断
  lastFiredAt?: number       // 上次触发时间
  nextFireAt: number[]       // 接下来最多 4 次触发时间戳
}
```

持久化文件（`.sema/scheduled_tasks.json`）只落盘核心字段（`id / schedule / task / repeat / createdAt / lastFiredAt`），运行时字段（`nextFireAt`、`describeCronExpression`、`activatedAt` 等）在加载时重新计算。

## 关键参数

| 常量 | 值 | 含义 |
|------|----|------|
| `MAX_TASKS` | 20 | 全局定时任务上限，超出时 `createTask` 抛错 |
| `TICK_INTERVAL` | 60_000（60s） | 扫描间隔，与 cron 最小粒度一致 |
| `RECURRING_EXPIRE_MS` | 10 天 | 循环任务在本轮调度中持续 10 天后自动停调度（`status=false`），不删持久化文件，下次启动重新计 |
| `CRON_TASKS_FILE` | `.sema/scheduled_tasks.json` | 持久化文件路径 |

## 调度循环（tick）

定时器按需启停，避免空转：

- `ensureRunning()`：创建/恢复任务时启动 `setInterval`，并调用 `timer.unref()` 不阻塞进程退出
- `stop()`：当 `tasks` 为空或没有任何启用任务（`hasActiveTasks()` 为 false）时关闭定时器

每次 `tick()`（60s 一次）对所有任务执行判定：

```
对每个 task:
  1. 循环任务且距 activatedAt 超过 10 天 → status=false，跳过（过期）
  2. status=false → 跳过（禁用）
  3. nextFireAt 为空 或 nextFireAt[0] > now → 未到点，跳过
  4. lastFiredAt >= nextFireAt[0] → 本次已触发过，跳过（去重）
  5. resolveTarget(task) 无目标会话 → 本轮跳过，下轮重试
  6. fire(task, cb)，记录 lastFiredAt
       - repeat:  重算 nextFireAt（未来 4 次），persist 则回写文件
       - 一次性:  加入待删除列表，tick 结束后删除并回写
```

## 目标会话解析（resolveTarget）

触发时需决定把指令注入哪个会话，采用"来源优先、活跃兜底"三级回退：

1. 任务自带 `sessionId` 且该会话仍注册了回调 → **来源会话**
2. 否则（持久化任务恢复后、或来源会话已关闭）→ `StateManager.getActiveSessionId()` 指向的 **UI 当前活跃会话**
3. 再否则 → `notifyRegistry.getAny()` 取任意已注册会话**兜底**

三级都没有命中时本轮跳过，**不丢失任务**——下一个 tick 会再次尝试。

## 触发消息格式

`fire()` 构造一条 `[cron-notification]` 文本交给目标会话的回调：

```
[cron-notification] task_id=abc123 schedule=*/5 * * * * repeat=true
- schedule: 每 5 分钟执行一次
- task: 检查 CI 构建状态并汇报
The above scheduled task has been triggered. Please execute the prompt.
```

回调即 `SemaEngine` 注册的 `processUserInput(msg, task.task, false, undefined, 'cron')`：忙时入队为 inject、空闲时立即 `startQuery`，注入路径与后台任务一致（后台任务为 silent 不可见，cron 为可见并带来源标签）。

## 事件

| 事件 | 触发时机 |
|------|---------|
| `cron:update` | 任务列表变化（创建、删除、启用/禁用、一次性任务触发后被删）时，由 `emitUpdate()` 发出，供 UI 刷新面板 |

## 与后台任务的区别

| 维度 | 后台任务（TaskManager） | 定时任务（CronManager） |
|------|------------------------|------------------------|
| 触发来源 | LLM 主动 spawn 一个进程/子代理 | 到达 cron 时间点自动触发 |
| 运行内容 | 独立运行的 shell 进程 / SubAgent | 注入一段提示词，起一轮新对话 |
| 生命周期 | 任务结束即归档 | 周期任务反复触发，直至删除或 10 天过期 |
| 限额 | 按会话 5 个 running | 全局 20 个 |
| 通知 | `task-notification`（结束时） | `cron-notification`（到点时） |
| 共用机制 | 经 `SessionNotifyRegistry` 注入 silent 输入（UI 不可见） | 经同一注册表注入 `source='cron'` 输入（UI 显示为带标签的用户消息） |

## 进一步了解

- [定时任务使用](wiki/getting-started/basic-usage/cron-usage) — cron 表达式、工具参数、典型场景与最佳实践
- [任务管理概述](wiki/core-concepts/task-management/overview) — 后台任务与定时任务的整体定位与共享注入机制
- [后台任务](wiki/core-concepts/task-management/background-task) — `TaskManager` 后台任务系统

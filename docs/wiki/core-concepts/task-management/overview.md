# 任务管理概述

任务管理统管所有"脱离当前会话主对话循环、独立产生结果"的工作，由两根支柱组成：

- **[后台任务](wiki/core-concepts/task-management/background-task)** — 由 `TaskManager` 调度，承载 LLM 主动 spawn 的 shell 进程（RunShell）与子代理（SubAgent），用于长耗时、可与主对话并行的工作。
- **[定时任务](wiki/core-concepts/task-management/cron-task)** — 由 `CronManager` 调度，按 cron 时间表反复或一次性触发，到点把一段提示词注入会话、唤起一轮新对话。

两者由不同管理器负责、面向不同场景，但**共享同一套"结果注入会话"的解耦机制**，因此放在同一层统一理解。

## 共享机制：通知注入

无论后台任务完成，还是定时任务到点，最终都通过 `SessionNotifyRegistry` 把一段文本作为 `silent` 用户输入注入目标会话：

```
TaskManager._notify(record)          CronManager.fire(task)
        │                                     │
        ▼                                     ▼
   notifyRegistry.get(sessionId)(msg)   （来源优先 / 活跃兜底）
        │                                     │
        └──────────────┬──────────────────────┘
                       ▼
   SemaEngine.processUserInput(msg, undefined, silent=true)
                       ▼
        会话忙 → 入队；会话空闲 → 立即起一轮
```

`silent` 注入保证：任务结果/触发不会打断当前轮次，但会在目标会话下一轮自然进入 LLM 视野。两套系统都在 `SemaEngine` 构造时各自调用 `setNotifyCallback(sessionId, cb)` 完成注册。

## 后台任务 vs 定时任务

| 维度 | 后台任务（TaskManager） | 定时任务（CronManager） |
|------|------------------------|------------------------|
| 触发来源 | LLM 主动 spawn 一个进程/子代理 | 到达 cron 时间点自动触发 |
| 运行内容 | 独立运行的 shell 进程 / SubAgent | 注入一段提示词，起一轮新对话 |
| 生命周期 | 任务结束即归档 | 周期任务反复触发，直至删除或 10 天过期 |
| 限额 | 每会话 5 个 running | 全局 20 个 |
| 持久化 | 不持久化（随会话） | 可选 `persist` 到 `.sema/scheduled_tasks.json` |
| 通知文本 | `task-notification`（结束时） | `cron-notification`（到点时） |
| 注入路由 | 严格按归属 `sessionId` | 来源优先、活跃会话兜底 |
| 共用机制 | 均经 `SessionNotifyRegistry` 注入会话 silent 输入 | 同左 |

## 子页面

- [后台任务](wiki/core-concepts/task-management/background-task) — `TaskManager` 调度、任务记录结构、流式输出与通知
  - [RunShell 后台任务](wiki/core-concepts/task-management/bash-task) — `spawnRunShellTask` / `takeoverTask` 与子进程模型
  - [SubAgent 后台任务](wiki/core-concepts/task-management/agent-task) — 前台/后台 SubAgent 与转后台机制
- [定时任务](wiki/core-concepts/task-management/cron-task) — `CronManager` 的 cron 调度循环与触发注入机制

> 使用层教程见 [后台任务使用](wiki/getting-started/basic-usage/background-task-usage) 与 [定时任务使用](wiki/getting-started/basic-usage/cron-usage)。

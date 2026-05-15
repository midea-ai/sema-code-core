# 定时任务使用

Sema Core 内置定时任务（Cron）系统，支持周期性任务和一次性提醒。LLM 通过 `create_cron`、`list_crons`、`del_cron` 三个工具自主调度，到点后自动将任务指令注入主对话。

## 两种模式

| 模式 | `repeat` | 说明 | 适用场景 |
|------|----------|------|----------|
| **周期性任务** | `true`（默认） | 按 cron 表达式反复执行，10 天后自动过期 | "每 5 分钟检查一次构建状态" |
| **一次性提醒** | `false` | 触发一次后自动删除 | "下午 2:30 提醒我检查部署" |

## 持久化

| `persist` | 存储位置 | 生命周期 |
|-----------|---------|---------|
| `false`（默认） | 仅内存 | 会话结束即清除 |
| `true` | `.sema/scheduled_tasks.json` | 跨会话保留，下次启动自动恢复 |

> **使用建议**：只有用户明确要求"永久保留"、"每天都跑"时才使用 `persist: true`；临时提醒保持默认即可。

## Cron 表达式

使用标准 5 字段格式，基于**用户本地时间**，无需时区转换：

```
分 时 日 月 星期
```

### 常见示例

| 表达式 | 含义 | 中文描述 |
|--------|------|----------|
| `*/5 * * * *` | 每 5 分钟 | 每 5 分钟执行一次 |
| `7 * * * *` | 每小时第 7 分钟 | 每小时执行一次 |
| `57 8 * * *` | 每天早上 8:57 | 每天早上执行一次 |
| `0 9 * * 1-5` | 工作日上午 9 点 | 周一到周五早上 9 点 |
| `30 14 17 4 *` | 4 月 17 日下午 2:30 | 一次性场景 |
| `0 0 1 * *` | 每月 1 日零点 | 每月执行一次 |

### 字段说明

| 字段 | 范围 | 特殊字符 |
|------|------|----------|
| 分钟 | 0-59 | `*` `,` `-` `/` |
| 小时 | 0-23 | `*` `,` `-` `/` |
| 日期 | 1-31 | `*` `,` `-` `/` |
| 月份 | 1-12 | `*` `,` `-` `/` |
| 星期 | 0-7（0 和 7 都代表周日） | `*` `,` `-` `/` |

## LLM 工具

### create_cron — 创建定时任务

```json
{
  "schedule": "57 8 * * *",
  "task": "检查昨日构建是否成功，如果失败请汇总原因",
  "repeat": true,
  "persist": false
}
```

**参数说明**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `schedule` | `string` | ✓ | 标准 5 字段 cron 表达式（本地时区） |
| `task` | `string` | ✓ | 每次触发时要执行的提示词 |
| `repeat` | `boolean` | — | `true`（默认）= 周期性执行；`false` = 一次性触发 |
| `persist` | `boolean` | — | `true` = 持久化到文件；`false`（默认）= 仅内存 |

**返回值**：任务 ID（8 位 16 进制字符串），后续可用于查询或删除。

### list_crons — 列出所有定时任务

无参数，返回所有任务（含持久化和会话临时任务）。

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `string` | 任务唯一标识 |
| `schedule` | `string` | cron 表达式 |
| `task` | `string` | 触发时执行的提示词 |
| `repeat` | `boolean` | 是否为周期性任务 |
| `persist` | `boolean` | 是否持久化 |
| `status` | `boolean` | 启用/禁用状态 |
| `describeCronExpression` | `string` | 人类可读的 cron 描述 |
| `nextFireAt` | `number[]` | 接下来最多 4 次触发时间戳 |
| `lastFiredAt` | `number` | 上次触发时间（可选） |
| `createdAt` | `number` | 创建时间戳 |
| `activatedAt` | `number` | 本轮调度起始时间 |

### del_cron — 删除定时任务

传入任务 ID 即可删除。持久化任务会从 `.sema/scheduled_tasks.json` 中移除。

## 用户操作 API

```javascript
// 获取所有定时任务
const tasks = await sema.getCronTasks()
tasks.forEach(t => {
  console.log(`[${t.id}] ${t.schedule} - ${t.describeCronExpression} (启用：${t.status})`)
})

// 启用 / 禁用任务
sema.enableCronTask(taskId)
sema.disableCronTask(taskId)

// 删除任务
sema.deleteCronTask(taskId)
```

## 事件

```javascript
sema.on('cron:update', () => {
  // 任务列表发生变化（创建、删除、启用/禁用）时触发
  const tasks = sema.getCronTasks()
  renderCronPanel(tasks)
})
```

## 触发机制

定时任务的检查间隔为 60 秒（与 cron 最小粒度一致）。当任务到达触发时间时，系统会构造一条 `<cron-notification>` 消息注入主对话队列，主代理在下一轮 idle 时执行对应任务指令。

**通知消息格式**：

```
[cron-notification] task_id=abc123 schedule=*/5 * * * * repeat=true
- schedule: 每 5 分钟执行一次
- task: 检查 CI 构建状态并汇报
The above scheduled task has been triggered. Please execute the prompt.
```

> **注意**：只有主代理处于 idle 状态时才会检查和触发任务，确保不会打断正在进行的对话。

## 主要限制

| 限制 | 说明 |
|------|------|
| **最大任务数** | 20 个 |
| **循环任务过期** | 单次会话中持续 10 天后自动停止调度（不删除持久化文件，下次启动重新计算） |
| **仅主代理可操作** | 子代理（SubAgent）内部不允许创建或管理定时任务 |
| **会话切换清空临时任务** | `createSession` 时非持久化任务会被清除 |
| **cron 验证** | 至少在 31 天内有一次匹配，否则拒绝创建 |

## 典型场景

### 1. 定时检查构建状态

```
用户：每 10 分钟检查一下 CI 构建状态
LLM 调用 create_cron：
  schedule="*/10 * * * *"
  task="检查 CI 构建状态并汇报"
  repeat=true
```

### 2. 一次性提醒

```
用户：下午 3 点提醒我提交 PR
LLM 调用 create_cron：
  schedule="0 15 * * *"
  task="提醒用户提交 PR"
  repeat=false
```

### 3. 持久化日报任务

```
用户：每天早上 9 点帮我生成昨天的代码变更摘要，永久保留
LLM 调用 create_cron：
  schedule="0 9 * * *"
  task="生成昨日代码变更摘要"
  repeat=true
  persist=true
```

### 4. 工作日定时任务

```
用户：工作日早上 9 点检查代码审查状态
LLM 调用 create_cron：
  schedule="0 9 * * 1-5"
  task="检查代码审查状态并汇总"
  repeat=true
```

## 任务管理最佳实践

### 1. 合理设置持久化

- **临时任务**：使用默认的 `persist: false`，如会议提醒、临时检查
- **长期任务**：明确要求"永久"、"每天"时使用 `persist: true`

### 2. 避开整点

建议将 cron 表达式设置为非整点时间（如 `:07`、`:57`），分散系统负载：

```javascript
// 推荐：每小时第 7 分钟
schedule="7 * * * *"

// 推荐：每天早上 8:57
schedule="57 8 * * *"
```

### 3. 任务描述清晰

在 task 中明确任务目标和期望输出：

```javascript
// 不推荐
task="检查状态"

// 推荐
task="检查 CI 构建状态，如果失败请汇总错误原因并给出修复建议"
```

## 相关源码

- 定时任务管理器：`src/manager/CronManager.ts`
- 任务类型定义：`src/types/cron.ts`
- Cron 表达式工具：`src/util/cron.ts`
- SemaCore 公共 API：`src/core/SemaCore.ts`

## 进一步了解

定时任务的内置工具详细参数与实现：

- [定时任务创建工具 create_cron](wiki/core-concepts/tool-system/built-in-tools/croncreatetool)
- [定时任务列表工具 list_crons](wiki/core-concepts/tool-system/built-in-tools/cronlisttool)
- [定时任务删除工具 del_cron](wiki/core-concepts/tool-system/built-in-tools/crondeletetool)

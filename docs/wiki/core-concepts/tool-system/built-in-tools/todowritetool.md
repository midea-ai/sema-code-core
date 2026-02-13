# 规划工具 TodoWrite

管理任务清单，向用户展示 AI 的工作进度和规划。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `todos` | `TodoItem[]` | ✓ | 任务列表 |

### TodoItem 结构

```javascript
interface TodoItem {
  content: string                                  // 任务描述（不可为空）
  status: 'pending' | 'in_progress' | 'completed' // 任务状态
  activeForm: string                               // 任务进行中时展示的文本（必填，不可为空）
}
```

> **注意**：`activeForm` 是必填字段，每个 todo 都必须提供非空值。

## 基本属性

- **isReadOnly**：`false`（串行执行）
- **权限**：无需权限
- **Plan 模式**：不可用（被排除）


## 智能更新

TodoWrite 内部实现了智能更新逻辑，通过 StateManager 避免不必要的全量替换：

**子集更新**：若传入的 todos 全部携带有效 `id` 且均能在当前 todos 中找到对应 `id`，则只更新匹配任务的字段，其余任务保持不变。

**全量替换**：否则（有任意 todo 缺少 `id` 或包含新 `id`），完全替换当前任务列表。

> 由于 Tool 的输入 schema 不包含 `id` 字段，通过 TodoWrite 传入的 todos 不携带 `id`，因此每次调用实际上均触发全量替换。`id` 是 StateManager 内部用于跨调用追踪任务的扩展字段。


## 限制规则

- 同一时刻**最多只能有一个** `in_progress` 状态的任务
- 传入多个 `in_progress` 任务时，工具会返回验证错误
- 每个 todo 的 `content` 和 `activeForm` 均不可为空字符串


## 触发事件

每次 TodoWrite 执行后，**主代理**触发 `todos:update` 事件（子代理不触发）：

```javascript
sema.on('todos:update', (todos: TodoItem[]) => {
  // 更新 UI 中的任务列表
  renderTodoList(todos)
})
```


## 使用场景

AI 在处理复杂多步骤任务时，会主动调用 TodoWrite 来：

1. **任务开始前**：创建完整的任务列表（全部 `pending`）
2. **开始某任务**：将其标记为 `in_progress`
3. **完成某任务**：将其标记为 `completed`
4. **发现新任务**：追加到列表

```javascript
// AI 调用示例（伪代码）
// 1. 创建任务列表
TodoWrite([
  { content: "读取 package.json", status: "pending", activeForm: "读取 package.json 中" },
  { content: "分析依赖关系", status: "pending", activeForm: "分析依赖关系中" },
  { content: "生成报告", status: "pending", activeForm: "生成报告中" },
])

// 2. 开始第一个任务
TodoWrite([
  { content: "读取 package.json", status: "in_progress", activeForm: "读取 package.json 中" },
  { content: "分析依赖关系", status: "pending", activeForm: "分析依赖关系中" },
  { content: "生成报告", status: "pending", activeForm: "生成报告中" },
])

// 3. 完成并进入下一个
TodoWrite([
  { content: "读取 package.json", status: "completed", activeForm: "读取 package.json 中" },
  { content: "分析依赖关系", status: "in_progress", activeForm: "分析依赖关系中" },
  { content: "生成报告", status: "pending", activeForm: "生成报告中" },
])
```

# 退出 Plan 模式工具 ExitPlanMode

在 Plan 模式下，AI 完成规划并将计划写入文件后，调用此工具请求用户审批并切换到 Agent 模式开始执行。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `planFilePath` | `string` | ✓ | 计划文件的绝对路径（必须是 `.md` 文件） |

> **注意**：此工具不直接接收计划内容，而是从 `planFilePath` 指定的文件中读取内容。调用前需先将计划写入该文件。

## 基本属性

- **isReadOnly**：`false`（会修改 agentMode 和消息历史）
- **仅在 Plan 模式下有效**


## 退出选项

用户会收到两个选择：

| 选项 | 行为 |
|------|------|
| `startEditing` | 切换到 Agent 模式，**保留**当前对话历史 |
| `clearContextAndStart` | 切换到 Agent 模式，**清空**历史，以计划内容重新开始 |

**startEditing** 适合：规划较短，上下文不多，AI 可以直接开始实现。

**clearContextAndStart** 适合：规划对话较长，清空历史可以给实现阶段提供更多 token 空间。


## 触发流程

```
AI 在 Plan 模式调用 ExitPlanMode（传入 planFilePath）
      │
      ▼
读取 planFilePath 文件内容
      │
      ▼
emit plan:exit:request {
  agentId, planFilePath, planContent, options
}
      │
      ▼
等待 plan:exit:response 事件
      │
      ▼
用户选择 startEditing？
├─ 是 → 切换模式，保留历史，继续对话
└─ 否（clearContextAndStart）→
       清空消息历史
       以 "Implement the following plan:\n\n{planContent}" 作为新消息
       emit plan:implement { planFilePath, planContent }
```


## 回应方式

```javascript
sema.on('plan:exit:request', async ({ agentId, planContent, options }) => {
  // 展示计划给用户
  showPlanPreview(planContent)

  // 获取用户选择
  const selected = await promptUser([
    { label: options.startEditing, value: 'startEditing' },
    { label: options.clearContextAndStart, value: 'clearContextAndStart' },
  ])

  // 通过事件总线回传用户选择
  eventBus.emit('plan:exit:response', { agentId, selected })
})

// 监听计划实施开始（仅 clearContextAndStart 时触发）
sema.on('plan:implement', ({ planFilePath, planContent }) => {
  console.log('计划已确认，AI 开始实施')
})
```


## 上下文重建

无论哪种选项，退出 Plan 模式后都会发生上下文重建：

1. `agentMode` 切换为 `'Agent'`
2. 系统提示词重新生成（不含 Plan 模式提示）
3. 工具列表重新构建（加入 `TodoWrite`）
4. `startEditing`：保留消息历史继续
5. `clearContextAndStart`：清空历史，以计划内容作为新的用户消息开始

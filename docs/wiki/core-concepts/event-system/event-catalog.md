# 事件类型

## 会话生命周期

### `session:ready`

会话初始化完成，可以开始发送用户输入。

```javascript
{
  workingDir: string           // 工作目录
  sessionId: string            // 会话 ID
  historyLoaded: boolean       // 是否从文件恢复了历史消息
  usage: {
    useTokens: number
    maxTokens: number
    promptTokens: number
  }
  projectInputHistory: string[] // 项目历史输入记录
}
```

### `session:interrupted`

用户调用 `interruptSession()` 中断了执行。

```javascript
{
  agentId: string  // 被中断的 Agent ID
  content: string  // 中断原因
}
```

### `session:error`

发生了无法恢复的错误。

```javascript
{
  type: 'api_error' | 'fatal_error' | 'context_length_exceeded' | 'model_error'
  error: {
    code: string
    message: string
    details?: any
  }
}
```

### `session:cleared`

会话已重置（消息历史清空）。

```javascript
{
  sessionId: string | null  // 被清空的会话 ID，null 表示当前会话
}
```


## 状态管理

### `state:update`

处理状态变化。

```javascript
{
  state: 'idle' | 'processing'
}
```

- `processing`：开始处理用户输入
- `idle`：处理完成（正常结束或中断后）


## AI 消息

### `message:thinking:chunk`

AI 流式输出的思考内容片段（Extended Thinking 功能）。

```javascript
{
  content: string  // 累积的全部思考内容
  delta: string    // 本次新增的片段
}
```

### `message:text:chunk`

AI 流式输出的文本响应片段。

```javascript
{
  content: string  // 累积的全部文本
  delta: string    // 本次新增的片段
}
```

### `message:complete`

AI 完成本轮响应（可能还有后续工具调用）。

```javascript
{
  agentId: string      // 发出响应的 Agent ID
  reasoning: string    // 完整思考内容
  content: string      // 完整文本响应
  hasToolCalls: boolean
  toolCalls?: Array<{
    name: string
    args: Record<string, any>  // 工具参数
  }>
}
```


## 工具事件

### `tool:permission:request`

工具需要用户授权才能执行。必须调用 `respondToToolPermission()` 回应，否则执行将一直等待。

```javascript
{
  agentId: string
  toolName: string                        // 工具名称
  title: string                           // 展示给用户的标题
  content: string | Record<string, any>   // 工具调用详情（可能含 diff 预览等）
  options: Record<string, string>         // 可选操作字典，key 为操作标识，value 为显示文本
}
```

**回应方法**：

```javascript
sema.respondToToolPermission({
  toolName: data.toolName,
  selected: 'agree',   // 或 'allow' / 'refuse' / 反馈文本
})
```

### `tool:permission:response`

用户已响应权限请求。

```javascript
{
  toolName: string
  selected: string
}
```

### `tool:execution:complete`

工具成功执行完毕。

```javascript
{
  agentId: string
  toolName: string
  title: string                           // 简短标题
  summary: string                         // 执行摘要
  content: string | Record<string, any>   // 工具返回的详细内容
}
```

### `tool:execution:error`

工具执行失败。

```javascript
{
  agentId: string
  toolName: string
  title: string
  content: string   // 错误信息
}
```


## Plan 模式

### `plan:exit:request`

AI 请求退出 Plan 模式（调用了 ExitPlanMode 工具）。必须调用 `respondToPlanExit()` 回应。

```javascript
{
  agentId: string
  planFilePath: string   // 计划文件路径（.md）
  planContent: string    // 计划文件内容
  options: {
    startEditing: string           // 选项显示文本：开始代码编辑
    clearContextAndStart: string   // 选项显示文本：清理上下文，并开始代码编辑
  }
}
```

**回应方法**：

```javascript
sema.respondToPlanExit({
  agentId: data.agentId,
  selected: 'startEditing',  // 或 'clearContextAndStart'
})
```

### `plan:exit:response`

用户已响应 Plan 退出请求。

```javascript
{
  agentId: string
  selected: 'startEditing' | 'clearContextAndStart'
}
```

### `plan:implement`

Plan 模式退出，已清空上下文，准备开始实施。仅当用户选择 `clearContextAndStart` 时触发。

```javascript
{
  planFilePath: string
  planContent: string
}
```


## 问答交互

### `ask:question:request`

AI 请求向用户提问（AskUserQuestion 工具调用）。必须调用 `respondToAskQuestion()` 回应，否则执行将一直等待。

```javascript
{
  agentId: string
  questions: Array<{
    question: string        // 问题内容
    header: string          // 问题标签（最多 12 字符）
    options: Array<{
      label: string         // 选项显示文本
      description: string   // 选项说明
    }>
    multiSelect: boolean    // 是否允许多选
  }>
  metadata?: {
    source?: string         // 问题来源标识
  }
}
```

**回应方法**：

```javascript
sema.respondToAskQuestion({
  agentId: data.agentId,
  answers: { '问题内容': '选中的选项label' },  // 多选时用逗号分隔
})
```

### `ask:question:response`

用户已响应问答请求。

```javascript
{
  agentId: string
  answers: Record<string, string>  // 问题 -> 答案（多选时用逗号分隔）
}
```


## Todos

### `todos:update`

任务列表发生变化（TodoWrite 工具执行后触发）。

```javascript
TodoItem[]

interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string   // in_progress 状态时展示的进行中描述
}
```


## 其他事件

### `file:reference`

解析到用户输入中的 `@文件引用`。

```javascript
{
  references: Array<{
    type: 'file' | 'dir'
    name: string
    content: string
  }>
}
```

### `conversation:usage`

每轮对话完成后的 Token 使用统计。

```javascript
{
  usage: {
    useTokens: number    // 当前已用 tokens
    maxTokens: number    // 上下文窗口大小
    promptTokens: number // prompt 部分 tokens
  }
}
```

### `compact:exec`

上下文压缩执行完毕。

```javascript
{
  errMsg?: string        // 压缩失败时的错误信息
  tokenBefore: number    // 压缩前 token 数
  tokenCompact: number   // 压缩后 token 数
  compactRate: number    // 压缩率（0-1）
}
```

### `topic:update`

检测到对话话题更新（可用于显示标题）。

```javascript
{
  isNewTopic: boolean
  title: string
}
```

### `task:agent:start`

SubAgent 开始执行。

```javascript
{
  taskId: string
  subagent_type: string
  description: string
  prompt: string
}
```

### `task:agent:end`

SubAgent 执行结束。

```javascript
{
  taskId: string
  status: 'completed' | 'failed' | 'interrupted'
  content: string   // 执行结果或错误信息
}
```

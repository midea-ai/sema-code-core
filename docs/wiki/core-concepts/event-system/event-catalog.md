# 事件类型目录

本文档列出 Sema Core 中所有可监听事件的名称、数据结构和使用说明。

> **进程级事件**：`cron:update` 和 `mcp:server:status` 属于进程级事件，描述全局资源状态变化，与具体会话无关，应通过 `SemaCore.on` 订阅。进程级事件监听器生命周期跟随 Core 实例，`dispose()` 时自动摘除。其余事件均为会话级事件，通过 `SemaSession.on` 订阅。

## 会话生命周期

### `session:ready`

会话初始化完成，可以开始发送用户输入。

```typescript
{
  pid: number                      // Core 进程 ID
  workingDir?: string              // 工作目录路径；未显式配置 workingDir 时可能为空
  sessionId: string                // 会话唯一标识
  historyLoaded: boolean           // 是否加载了历史记录
  usage: {
    useTokens: number              // 当前会话已使用的 token 数
    maxTokens: number              // 模型最大 token 限制
    promptTokens: number           // 提示词使用的 token 数
  }
  projectInputHistory: string[]    // 项目历史输入记录
  todos: TodoItem[]                // 待办事项列表
  readFileTimestamps: Record<string, number>  // 文件读取时间戳
}
```

### `session:interrupted`

用户调用 `session.interrupt()` 中断了当前会话执行。

```typescript
{
  agentId: string   // 被中断的代理 ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  content: string   // 中断原因描述，如 "Process cancelled by user"
}
```

### `session:error`

发生了无法恢复的错误。

```typescript
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

```typescript
{
  sessionId: string | null   // 被清空的会话 ID，null 表示当前会话
}
```

## 状态管理

### `state:update`

处理状态变化。

```typescript
{
  state: 'idle' | 'processing'
}
```

| 状态 | 含义 |
|------|------|
| `idle` | 空闲，等待用户输入 |
| `processing` | AI 处理中 |

## 用户输入

### `input:received`

`processUserInput` 收到用户输入时触发，无论是立即处理还是入队等待。

```typescript
{
  inputId: string          // 输入唯一标识，用于区分相同内容的不同输入
  input: string            // 处理后的输入内容
  originalInput?: string   // 原始输入内容
  queued: boolean          // 是否入队等待（true 表示当前正在处理中，输入已入队）
  queueLength: number      // 当前队列长度（入队后的长度）
}
```

### `input:processing`

`processQuery` 真正开始处理用户输入时触发。

```typescript
{
  inputId: string          // 输入唯一标识，与 input:received 中的 inputId 对应
  input: string            // 正在处理的输入内容
  originalInput?: string   // 原始输入内容
}
```

## AI 消息

### `message:thinking:chunk`

AI 流式输出的思考内容片段（Extended Thinking 功能）。

```typescript
{
  id: string     // 消息唯一 ID，对应 Anthropic Message 的 id
  delta: string  // 本次新增的思考片段
}
```

### `message:text:chunk`

AI 流式输出的文本响应片段。

```typescript
{
  id: string     // 消息唯一 ID，对应 Anthropic Message 的 id
  delta: string  // 本次新增的文本片段
}
```

### `message:complete`

AI 完成本轮响应（可能还有后续工具调用）。

```typescript
{
  id: string              // 消息唯一 ID，对应 Anthropic Message 的 id
  agentId: string         // 发出响应的代理 ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  reasoning: string       // 完整思考内容（如果有）
  content: string         // 完整文本响应
  hasToolCalls: boolean   // 是否包含工具调用
  toolCalls?: Array<{
    name: string          // 工具名称
  }>
}
```

## 工具事件

### `tool:permission:request`

工具需要用户授权才能执行。必须在当前 `SemaSession` 上调用 `respondToToolPermission()` 回应，否则执行将一直等待。

```typescript
{
  agentId: string                          // 代理 ID
  toolId: string                           // 工具调用唯一 ID（对应 Anthropic ToolUseBlock 的 id）
  toolName: string                         // 工具名称
  title: string                            // 展示给用户的标题
  content: string | Record<string, any>    // 工具调用详情（可能含 diff 预览等）
  options: Record<string, string>          // 可选操作字典，key 为操作标识，value 为显示文本
}
```

**回应方法**：

```javascript
session.respondToToolPermission({
  toolId: data.toolId,
  toolName: data.toolName,
  selected: 'agree',   // 或 'allow' / 'refuse' / 其他自定义选项
})
```

### `tool:permission:response`

用户通过 `session.respondToToolPermission()` 发送的权限响应（内部事件）。

```typescript
{
  toolId: string    // 与请求中的 toolId 对应
  toolName: string
  selected: string  // 用户选择的操作标识
}
```

### `tool:execution:chunk`

工具执行期间，工具结果的中间态推送。结构与 `tool:execution:complete` 相同，`content` 仅包含本次新增的 delta。

```typescript
{
  agentId: string
  toolId: string
  toolName: string
  title: string
  summary: string
  content: string | Record<string, any>   // 仅本次新增的内容
}
```

### `tool:execution:complete`

工具成功执行完毕。

```typescript
{
  agentId: string                        // 代理 ID
  toolId: string                         // 工具调用唯一 ID（对应 Anthropic ToolUseBlock 的 id）
  toolName: string                       // 工具名称
  title: string                          // 简短标题
  summary: string                        // 执行摘要
  content: string | Record<string, any>  // 工具返回的详细内容
}
```

### `tool:execution:error`

工具执行失败。

```typescript
{
  agentId: string
  toolId?: string                 // 工具调用唯一 ID（对应 Anthropic ToolUseBlock 的 id）
  toolName: string
  title: string
  content: string                 // 错误信息
  input?: Record<string, any>     // 工具调用参数
}
```

## Todos

### `todos:update`

任务列表发生变化（create_todo / update_todo 工具执行后触发）。

```typescript
TodoItem[]

interface TodoItem {
  id: string                               // 任务唯一标识
  title: string                            // 任务标题
  status: 'pending' | 'in_progress' | 'completed'
  progressText: string                     // in_progress 状态时展示的进行中描述
}
```

## 问答交互

### `pick:option:request`

AI 请求向用户展示表单（`ask_form` 工具调用）。必须在当前 `SemaSession` 上调用 `respondToPickOption()` 回应，否则执行将一直等待。

```typescript
{
  agentId: string                          // 代理 ID
  questions: Array<
    | { type: 'radio'; id: string; label: string; required?: boolean; options: string[] }
    | { type: 'checkbox'; id: string; label: string; required?: boolean; options: string[]; maxSelections?: number }
    | { type: 'select'; id: string; label: string; required?: boolean; options: string[] }
    | { type: 'text'; id: string; label: string; required?: boolean; placeholder?: string }
    | { type: 'textarea'; id: string; label: string; required?: boolean; placeholder?: string }
  >                                        // 1-7 个问题
  estimatedTime?: string                   // UI 展示的预计填写时间
  intro?: string                           // 表单引导语
}
```

**回应方法**：

```javascript
session.respondToPickOption({
  agentId: data.agentId,
  answers: '- Framework: React\n- Features: Auth; Billing',
})
```

### `pick:option:response`

用户通过 `session.respondToPickOption()` 发送的问答响应（内部事件）。

```typescript
{
  agentId: string
  answers: string | null   // 预格式化纯文本答案；null 表示用户取消整个表单
}
```

## Plan 模式

### `plan:exit:request`

AI 请求退出 Plan 模式（调用了 plan_to_agent 工具）。必须在当前 `SemaSession` 上调用 `respondToPlanExit()` 回应。

```typescript
{
  agentId: string
  planFilePath: string      // 计划文件相对路径
  planContent: string       // 计划文件内容
  options: {
    startEditing: string           // "开始代码编辑"
    clearContextAndStart: string   // "清理上下文，并开始代码编辑"
  }
}
```

**回应方法**：

```javascript
session.respondToPlanExit({
  agentId: data.agentId,
  selected: 'startEditing',  // 或 'clearContextAndStart'
})
```

### `plan:exit:response`

用户通过 `session.respondToPlanExit()` 发送的 Plan 退出响应（内部事件）。

```typescript
{
  agentId: string
  selected: 'startEditing' | 'clearContextAndStart'
}
```

### `plan:implement`

Plan 模式退出，已清空上下文，准备开始实施。仅当用户选择 `clearContextAndStart` 时触发。

```typescript
{
  planFilePath: string   // 计划文件相对路径
  planContent: string    // 计划文件 .md 的内容
}
```

## SubAgent

### `task:agent:start`

SubAgent 开始执行。

```typescript
{
  taskId: string         // 子代理任务唯一标识
  agent_type: string     // 代理类型
  title: string          // 任务标题
  instructions: string   // 任务指令
  background: boolean    // 是否后台运行
}
```

### `task:agent:end`

SubAgent 执行结束。

```typescript
{
  taskId: string                                      // 子代理任务唯一标识
  status: 'completed' | 'failed' | 'interrupted'      // 执行状态
  content: string   // 结果描述，如 'Interrupted' 或 'Done(12 tools use · 12.1k tokens · 2m 14s)'
}
```

## 后台任务

### `task:start`

后台任务启动（run_shell 后台命令或转入后台的 SubAgent）。

```typescript
{
  taskId: string
  pid?: number
  command: string
  filepath: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  type: 'RunShell' | 'SubAgent'
  agentType?: string   // SubAgent 任务专用：代理类型（对应 agent_type）
}
```

### `task:end`

后台任务结束。

```typescript
{
  taskId: string
  status: 'completed' | 'failed' | 'killed'
  summary: string
}
```

### `task:transfer`

前台 Agent 通过 `transferToBackground()` 转为后台运行时触发。数据格式与 `task:start` 一致，便于 UI 层统一处理。

```typescript
{
  taskId: string
  pid?: number
  command: string
  filepath: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  type: 'RunShell' | 'SubAgent'
  agentType?: string   // SubAgent 任务专用：代理类型（对应 agent_type）
}
```

## 自动编辑

### `autoEdit:update`

自动编辑模式开关状态变更。

```typescript
{
  enable: boolean   // 是否开启自动编辑
}
```

## 定时任务

### `cron:update`

定时任务列表发生变化时触发，UI 层收到后应重新加载任务列表。

```typescript
{}   // 无数据负载
```

> 进程级事件，通过 `SemaCore.on` 订阅。

## 旁路问答

### `quickchat:response`

用户通过 `/quickchat` 命令发起的旁路问题响应，不影响主对话状态。

```typescript
{
  question: string   // 用户问题
  content: string    // 回答内容
}
```

## 其他事件

### `file:reference`

解析到用户输入中的 `@文件引用`。

只有成功解析并生成补充信息的引用会进入该事件。图片会以图片内容块注入；PDF 由 `view_file` 处理，未指定范围时小 PDF 会读取，大 PDF 会提示使用分页参数；压缩包、可执行文件等不支持内联读取的二进制文件会被跳过。

```typescript
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

```typescript
{
  usage: {
    useTokens: number     // 当前会话已使用的 token 数
    maxTokens: number     // 模型最大 token 限制
    promptTokens: number  // 提示词使用的 token 数
  }
}
```

### `compact:exec`

上下文压缩执行完毕。

```typescript
{
  errMsg?: string       // 压缩失败时的错误信息
  tokenBefore: number   // 压缩前输入 token 数
  tokenCompact: number  // 压缩后输入 token 数
  compactRate: number   // 压缩率，如 0.235 表示压缩到 23.5%
}
```

### `topic:update`

检测到对话话题更新（可用于显示标题）。

```typescript
{
  isNewTopic: boolean   // 是否为新话题，false 表示 null（无新话题）
  title: string         // 标题内容
}
```

### `mcp:server:status`

MCP 服务器状态变更。事件数据为 `MCPServerInfo` 对象（详见 `src/types/mcp.ts`）。

> 进程级事件，通过 `SemaCore.on` 订阅。

### `config:no_models`

启动时未配置任何可用模型时触发。

```typescript
{
  message: string     // '未配置任何模型，请先添加模型配置'
  suggestion: string  // 建议操作（当前为空字符串）
}
```

# 工具架构

工具（Tool）是 Agent 与外部世界交互的唯一方式。每个工具封装一类能力，并通过统一接口接入 AI 对话循环。

## Tool 接口

所有工具（包括内置、MCP）都实现同一个接口：

```typescript
interface Tool<TInput extends z.ZodObject<any> = z.ZodObject<any>, TOutput = any> {
  // 工具名称（唯一标识，传给 LLM 的名称）
  name: string

  // 工具描述（告诉 LLM 何时使用此工具）
  description?: string | (() => string)

  // 输入参数 Schema（Zod 对象，建议使用 z.strictObject 拒绝额外字段）
  toolParams: TInput

  // 工具无副作用：跳过权限确认，且可并行执行
  isSafe: () => boolean

  // 工具虽非只读，但多个实例之间互相独立，可与其他可并发工具一起并发执行
  // 典型例子：Agent 工具，多个子代理实例间状态完全隔离
  canRunConcurrently?: () => boolean

  // 工具是否支持中断并返回部分结果（如 run_shell）
  // 实现并返回 true 时，工具被中断后会保留 genResultForAssistant 的结果；
  // 不实现或返回 false 时，中断会被替换为标准取消消息
  supportsInterrupt?: () => boolean

  // 执行前验证输入（返回 { result: false, message } 可阻止执行）
  validateInput?(
    input: z.infer<TInput>,
    agentContext: AgentContext
  ): Promise<ValidationResult>

  // 必需：将工具输出格式化为返回给 LLM 的内容（字符串或 content blocks）
  genResultForAssistant(output: TOutput): Anthropic.ToolResultBlockParam['content']

  // 生成权限请求的展示内容（用于 tool:permission:request 事件）
  genToolPermission?(input: z.infer<TInput>): {
    title: string
    summary?: string
    content: string | Record<string, any>
  }

  // 生成工具结果的展示内容（用于 tool:execution:complete 事件）
  genToolResultMessage?(output: TOutput, input?: z.infer<TInput>): {
    title: string
    summary: string
    content: string | Record<string, any>
  }

  // 获取工具调用的展示标题
  getDisplayTitle?(input?: z.infer<TInput>): string

  // 工具的实际执行逻辑（异步生成器）
  call(
    input: z.infer<TInput>,
    agentContext: AgentContext
  ): AsyncGenerator<
    {
      type: 'result'
      data: TOutput
      // 可选：覆盖 genResultForAssistant 的返回值
      resultForAssistant?: Anthropic.ToolResultBlockParam['content']
      // 可选：附加 content blocks（如图片），与 tool_result 一起返回给 LLM
      additionalBlocks?: Anthropic.ContentBlockParam[]
    },
    void,
    unknown
  >
}
```


## 三个执行策略相关的方法

| 方法 | 作用 | 默认 |
|------|------|------|
| `isSafe()` | 无副作用、可与其他安全工具并发执行 | 必填 |
| `canRunConcurrently()` | 非只读但实例间相互独立，可参与并发批次 | 未实现视为 `false` |
| `supportsInterrupt()` | 支持中断保留部分结果 | 未实现视为 `false` |

详见本文下方的[并发与串行执行](#并发与串行执行)与[中断与部分结果](#中断与部分结果)。


## 工具注册

```javascript
import { getBuiltinTools, getTools, getToolInfos, buildTools } from 'sema-core'

// 获取所有内置工具实例
const allTools = getBuiltinTools()

// 按名称过滤（传 null 或不传返回全部）
const filteredTools = getTools(['view_file', 'search_files', 'search_content'])
const allToolsAgain = getTools(null) // 返回全部

// 获取工具信息列表（含启用/禁用状态，由 useTools 配置决定）
const toolInfos = getToolInfos()
// => [{ name: 'run_shell', description: '...', status: 'enable' | 'disable' }, ...]

// 转换为 Anthropic SDK 格式（供 API 调用使用）
const sdkTools = buildTools(filteredTools)
```

> `buildTools` 还会读取核心配置 `disableBackgroundTasks`：当其为 `true` 时，会从 `run_shell` 与 `sub_agent` 的 toolParams 中自动剔除 `run_in_background` 字段，确保 LLM 看不到该参数。


## 工具分类

### 内置工具（21 个）

| 工具 | 类型 | isSafe | 备注 |
|------|------|-----------|------|
| [run_shell](wiki/core-concepts/tool-system/built-in-tools/bashtool) | 终端执行 | false | `supportsInterrupt`、支持后台任务 |
| [search_files](wiki/core-concepts/tool-system/built-in-tools/globtool) | 文件搜索 | true | |
| [search_content](wiki/core-concepts/tool-system/built-in-tools/greptool) | 文本搜索 | true | |
| [view_file](wiki/core-concepts/tool-system/built-in-tools/readtool) | 文件读取 | true | |
| [write_file](wiki/core-concepts/tool-system/built-in-tools/writetool) | 文件写入 | false | |
| [patch_file](wiki/core-concepts/tool-system/built-in-tools/edittool) | 文件编辑 | false | |
| [fetch_url](wiki/core-concepts/tool-system/built-in-tools/webfetchtool) | 网页抓取 | false | |
| [sub_agent](wiki/core-concepts/tool-system/built-in-tools/tasktool) | 子代理创建 | false | `canRunConcurrently`、支持后台任务 |
| [peek_bg_job](wiki/core-concepts/tool-system/built-in-tools/taskoutputtool) | 后台任务输出读取 | true | `supportsInterrupt` |
| [stop_bg_job](wiki/core-concepts/tool-system/built-in-tools/taskstoptool) | 后台任务停止 | false | |
| [Skill](wiki/core-concepts/tool-system/built-in-tools/skilltool) | Skill 调用 | false | |
| [NotebookEdit](wiki/core-concepts/tool-system/built-in-tools/notebookedittool) | Notebook 编辑 | false | |
| [ask_form](wiki/core-concepts/tool-system/built-in-tools) | 用户交互 | false | |
| [plan_to_agent](wiki/core-concepts/tool-system/built-in-tools/exitplanmodetool) | 退出 Plan 模式 | false | |
| [create_todo](wiki/core-concepts/tool-system/built-in-tools/taskcreatetool) | 任务创建 | false | `canRunConcurrently` |
| [get_todo](wiki/core-concepts/tool-system/built-in-tools/taskgettool) | 任务查询 | true | `canRunConcurrently` |
| [list_todos](wiki/core-concepts/tool-system/built-in-tools/tasklisttool) | 任务列表 | true | `canRunConcurrently` |
| [update_todo](wiki/core-concepts/tool-system/built-in-tools/taskupdatetool) | 任务更新 | false | `canRunConcurrently` |
| [create_cron](wiki/core-concepts/tool-system/built-in-tools/croncreatetool) | 定时任务创建 | false | `canRunConcurrently`、仅主代理 |
| [del_cron](wiki/core-concepts/tool-system/built-in-tools/crondeletetool) | 定时任务删除 | false | `canRunConcurrently` |
| [list_crons](wiki/core-concepts/tool-system/built-in-tools/cronlisttool) | 定时任务列表 | true | `canRunConcurrently` |

### MCP 工具

通过 `MCPToolAdapter` 将 MCP 服务器的工具适配为 Sema Tool 接口：

- 命名格式：`mcp__[serverName]_[toolName]`
- 权限 key：工具名（不含 `mcp__` 前缀）
- 由 `MCPManager` 动态注册和管理

### Skill 工具

`Skill` 工具本身是内置工具之一，它通过调用 Skill 注册表加载和执行 Skill 内容，间接扩展了 AI 的能力。


## 权限请求流程

非安全工具（`isSafe()` 返回 `false`）在执行前会经过权限检查：

1. 若 `abortController` 已中断（前序工具被拒绝/取消），直接返回取消消息，跳过执行
2. 调用 `PermissionManager.hasPermissionsToUseTool` 请求权限
3. 权限被拒绝时，返回拒绝消息并中止执行

```javascript
// RunTools.ts 内部执行流程（简化）
if (!tool.isSafe()) {
  if (abortController.signal.aborted) {
    yield createToolResultStopMessage(toolUseId)
    return
  }

  const permissionResult = await hasPermissionsToUseTool(
    tool, input, abortController, assistantMessage, agentId, toolUseID
  )

  if (!permissionResult.result) {
    yield { type: 'tool_result', content: permissionResult.message, is_error: true }
    return
  }
}
```

权限请求通过事件总线发布 `tool:permission:request` 事件，由宿主应用处理后回复 `tool:permission:response`。`genToolPermission` 方法提供请求展示内容（title、summary、content）。


## 添加自定义工具

参考 [创建自定义工具](wiki/core-concepts/tool-system/creating-custom-tools) 。


# 并发与串行执行

当 LLM 在一轮响应中发起多个工具调用时，Sema 会根据工具的 `isSafe()` 与 `canRunConcurrently()` 自动决定执行策略。

## 判定规则

```
本轮所有工具调用是否满足：每个工具 isSafe() === true || canRunConcurrently() === true ？
    │
    ├─ 是 → 并发执行（runToolsConcurrently）
    └─ 否 → 串行执行（runToolsSerially）
```

对应实现见 `src/core/Conversation.ts:180`：

```javascript
const canRunConcurrently = toolUseMessages.every(msg => {
  const tool = tools.find(t => t.name === msg.name)
  return tool?.isSafe?.() || tool?.canRunConcurrently?.() || false
})
```


### 并发执行

**条件**：本轮所有工具均为只读，或显式声明 `canRunConcurrently`。

```javascript
// 内部实现示意
const results = await Promise.all(
  toolCalls.map(tc => executeTool(tc))
)
// 按原始顺序返回结果（不受执行完成顺序影响）
```

**示例 1**：LLM 同时读取多个文件 / 搜索多个目录

```
LLM 调用:
  ├─ view_file("src/core/SemaCore.ts")     → 并行
  ├─ view_file("src/core/SemaEngine.ts")   → 并行
  └─ search_content("pattern", "src/")          → 并行
```

### 串行执行

**条件**：本轮存在任意一个 `isSafe() === false` 且未声明 `canRunConcurrently()` 的工具。

```javascript
// 内部实现示意
const results = []
for (const toolCall of toolCalls) {
  const result = await executeTool(toolCall)
  results.push(result)
}
```

**示例**：先写文件再编辑

```
LLM 调用:
  ├─ write_file("new-file.ts", content)  → 先执行
  └─ patch_file("new-file.ts", ...)       → 后执行
```

若并发执行，`patch_file` 可能在 `write_file` 完成前就开始，导致找不到文件。串行执行确保顺序安全。

### 混合场景

当 LLM 同时调用只读和写入工具时，整组均串行执行：

```
LLM 调用:
  ├─ view_file("config.ts")   → isSafe=true
  ├─ patch_file("main.ts", …)  → isSafe=false 且未声明 canRunConcurrently（触发串行）
  └─ search_files("**/*.ts")     → isSafe=true

→ 结果：所有三个工具串行执行
```


# 中断与部分结果

当用户中断（`abort`）正在执行的工具时，Sema 根据工具是否声明 `supportsInterrupt()` 采用不同策略：

| `supportsInterrupt()` | 中断时行为 |
|-----------------------|-----------|
| 未实现 / 返回 `false` | 丢弃工具产出，向 LLM 返回标准取消消息（`createToolResultStopMessage`）|
| 返回 `true` | 保留工具内部已生成的部分结果（由 `genResultForAssistant` 序列化），与中断标记一起返回 LLM |

实现该方法的内置工具：

- **run_shell**：中断时保留已捕获的 stdout / stderr，并附 `INTERRUPT_MESSAGE_FOR_TOOL_USE` 标记
- **peek_bg_job**：阻塞等待后台任务输出时被中断，会返回当前的输出快照与 `retrievalStatus: 'not_ready'`

实现细节见 `src/core/RunTools.ts:131`。


# 后台任务相关

`run_shell` 与 `sub_agent` 工具的 toolParams 都包含 `run_in_background` 字段，配合 `peek_bg_job` / `stop_bg_job` 工具，构成完整的后台任务能力：

- **启动**：`run_shell(run_in_background: true)` 直接 spawn 独立进程；`sub_agent(run_in_background: true)` 启动独立 AbortController 的子代理循环
- **接管**：`run_shell` 同步执行超时时，自动把底层 shell 接管为后台任务（`takeoverTask`）
- **读取**：`peek_bg_job(task_id, block, timeout)` 拉取已完成快照或阻塞等待
- **停止**：`stop_bg_job(task_id)` 向后台任务发起停止

约束：

- 子代理（`agentId !== MAIN_AGENT_ID`）强制不允许后台任务，`run_in_background` 即使被传入也被忽略
- 核心配置 `disableBackgroundTasks: true` 时：
  - `buildTools` 会从 `run_shell` / `sub_agent` 的 schema 中过滤 `run_in_background`，LLM 看不到该参数
  - 超时接管 / 转后台等路径同样禁用

详见 [RunShell 后台任务](wiki/core-concepts/task-management/bash-task) 与 [SubAgent 后台任务](wiki/core-concepts/task-management/agent-task)。

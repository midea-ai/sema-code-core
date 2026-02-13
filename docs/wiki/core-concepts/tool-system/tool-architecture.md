# 工具架构

工具（Tool）是 Agent 与外部世界交互的唯一方式。每个工具封装一类能力，并通过统一接口接入 AI 对话循环。

## Tool 接口

所有工具（包括内置、MCP）都实现同一个接口：

```javascript
interface Tool<TInput = ZodObject<any>, TOutput = any> {
  // 工具名称（唯一标识，传给 LLM 的名称）
  name: string

  // 工具描述（告诉 LLM 何时使用此工具）
  description?: string | (() => string)

  // 输入参数 Schema（Zod 对象）
  inputSchema: TInput

  // 是否为只读工具（影响并发执行策略）
  isReadOnly(): boolean

  // 执行前验证输入（返回 false 可阻止执行）
  validateInput?(
    input: z.infer<TInput>,
    agentContext: AgentContext
  ): Promise<ValidationResult>

  // 将工具输出转换为返回给 LLM 的字符串（必须实现）
  genResultForAssistant(output: TOutput): string

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
  ): AsyncGenerator<{ type: 'result'; data: TOutput; resultForAssistant?: string }, void>
}
```


## isReadOnly 的作用

`isReadOnly()` 决定工具在被批量调用时的执行策略：

- **返回 `true`**：工具可安全并行执行（不修改外部状态）
- **返回 `false`**：工具需要串行执行（防止竞态条件）

详见本文下方的[并发与串行执行](#并发与串行执行)。


## 工具注册

```javascript
import { getBuiltinTools, getTools, getToolInfos, buildTools } from 'sema-core'

// 获取所有内置工具实例
const allTools = getBuiltinTools()

// 按名称过滤（传 null 或不传返回全部）
const filteredTools = getTools(['Read', 'Glob', 'Grep'])
const allToolsAgain = getTools(null) // 返回全部

// 获取工具信息列表（含启用/禁用状态，由 useTools 配置决定）
const toolInfos = getToolInfos()
// => [{ name: 'Bash', description: '...', status: 'enable' | 'disable' }, ...]

// 转换为 Anthropic SDK 格式（供 API 调用使用）
const sdkTools = buildTools(filteredTools)
```


## 工具分类

### 内置工具（12 个）

| 工具 | 类型 | isReadOnly |
|------|------|-----------|
| [Bash](wiki/core-concepts/tool-system/built-in-tools/bashtool) | 终端执行 | false |
| [Glob](wiki/core-concepts/tool-system/built-in-tools/globtool) | 文件搜索 | true |
| [Grep](wiki/core-concepts/tool-system/built-in-tools/greptool) | 文本搜索 | true |
| [Read](wiki/core-concepts/tool-system/built-in-tools/readtool) | 文件读取 | true |
| [Write](wiki/core-concepts/tool-system/built-in-tools/writetool) | 文件写入 | false |
| [Edit](wiki/core-concepts/tool-system/built-in-tools/edittool) | 文件编辑 | false |
| [NotebookEdit](wiki/core-concepts/tool-system/built-in-tools/notebookedittool) | Notebook 编辑 | false |
| [TodoWrite](wiki/core-concepts/tool-system/built-in-tools/todowritetool) | 任务管理 | false |
| [Task](wiki/core-concepts/tool-system/built-in-tools/tasktool) | 子代理创建 | false |
| [Skill](wiki/core-concepts/tool-system/built-in-tools/skilltool) | Skill 调用 | false |
| [AskUserQuestion](wiki/core-concepts/tool-system/built-in-tools/askuserquestiontool) | 用户交互 | false |
| [ExitPlanMode](wiki/core-concepts/tool-system/built-in-tools/exitplanmodetool) | 退出 Plan 模式 | false |

### MCP 工具

通过 `MCPToolAdapter` 将 MCP 服务器的工具适配为 Sema Tool 接口：

- 命名格式：`mcp__[serverName]_[toolName]`
- 权限 key：工具名（不含 `mcp__` 前缀）
- 由 `MCPManager` 动态注册和管理

### Skill 工具

`Skill` 工具本身是内置工具之一，它通过调用 Skill 注册表加载和执行 Skill 内容，间接扩展了 AI 的能力。


## 权限请求流程

非只读工具（`isReadOnly()` 返回 `false`）在执行前会经过权限检查：

1. 若 `abortController` 已中断（前序工具被拒绝/取消），直接返回取消消息，跳过执行
2. 调用 `PermissionManager.hasPermissionsToUseTool` 请求权限
3. 权限被拒绝时，返回拒绝消息并中止执行

```javascript
// RunTools.ts 内部执行流程（简化）
if (!tool.isReadOnly()) {
  if (abortController.signal.aborted) {
    yield createToolResultStopMessage(toolUseId)
    return
  }

  const permissionResult = await hasPermissionsToUseTool(
    tool, input, abortController, assistantMessage, agentId
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

当 LLM 在一轮响应中发起多个工具调用时，Sema 会根据工具的 `isReadOnly()` 返回值自动决定执行策略。

## 工具执行

```
本轮所有工具调用中，是否存在 isReadOnly() = false 的工具？
    │
    ├─ 否（全部只读）→ 并发执行（Promise.all）
    └─ 是（有写操作）→ 串行执行（按顺序）
```


### 并发执行

**条件**：本轮所有工具的 `isReadOnly()` 均返回 `true`

```javascript
// 内部实现示意
const results = await Promise.all(
  toolCalls.map(tc => executeTool(tc))
)
// 按原始顺序返回结果（不受执行完成顺序影响）
```

**示例场景**：LLM 同时搜索多个文件

```
LLM 调用:
  ├─ Read("src/core/SemaCore.ts")     → 并行执行
  ├─ Read("src/core/SemaEngine.ts")   → 并行执行
  └─ Grep("pattern", "src/")         → 并行执行
```

三个工具同时发起，任一完成不需等待其他，总耗时取决于最慢的那个。


### 串行执行

**条件**：本轮存在任意一个 `isReadOnly()` 返回 `false` 的工具

```javascript
// 内部实现示意
const results = []
for (const toolCall of toolCalls) {
  const result = await executeTool(toolCall)
  results.push(result)
}
```

**示例场景**：先写文件再编辑

```
LLM 调用:
  ├─ Write("new-file.ts", content)  → 先执行（等待完成）
  └─ Edit("new-file.ts", ...)       → 后执行
```

若并发执行，Edit 可能在 Write 完成前就开始，导致找不到文件。串行执行确保顺序安全。

### 混合场景

当 LLM 同时调用只读和写入工具时，整组均串行执行：

```
LLM 调用:
  ├─ Read("config.ts")   → isReadOnly=true
  ├─ Edit("main.ts", …)  → isReadOnly=false（触发串行）
  └─ Glob("**/*.ts")     → isReadOnly=true

→ 结果：所有三个工具串行执行
```


## 性能建议

为了最大化并发执行的概率，LLM 在多个只读操作时（如同时搜索多个文件）会将它们合并在同一轮工具调用中返回，而不是分多轮。这是通过系统提示词引导 LLM 的行为。


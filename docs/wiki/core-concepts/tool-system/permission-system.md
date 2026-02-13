# 权限系统

权限系统确保 AI 在执行可能影响系统状态的操作前获得用户授权。

## 权限类型

| 类型 | 控制配置 | 默认行为 | 持久化格式 |
|------|---------|---------|-----------|
| 文件编辑 | `skipFileEditPermission` | 需要确认 | 会话级授权（不写入 allowedTools） |
| Bash 执行 | `skipBashExecPermission` | 需要确认 | `'Bash(命令前缀:*)'` 或 `'Bash(完整命令)'` |
| Skill 调用 | `skipSkillPermission` | 需要确认 | `'Skill(name)'` |
| MCP 工具 | `skipMCPToolPermission` | 需要确认 | `'mcp__server_tool'` |


## 权限检查流程

各工具类型的检查路径不同：

```
工具执行请求
     │
     ▼
skipXxxPermission = true？
     ├─ 是 → 直接执行 ✓
     └─ 否 → 文件编辑工具？
               ├─ 是 → hasGlobalEditPermission？
               │         ├─ 是 → isFileInAuthorizedScope？
               │         │         ├─ 是 → 直接执行 ✓
               │         │         └─ 否 → emit tool:permission:request
               │         └─ 否 → emit tool:permission:request
               └─ 否 → allowedTools 中已记录？
                         ├─ 是 → 直接执行 ✓
                         └─ 否 → 安全命令白名单？（仅 Bash）
                                   ├─ 是 → 直接执行 ✓
                                   └─ 否 → emit tool:permission:request
                                             │
                                             ▼
                                         等待 respondToToolPermission()
                                             │
                                         selected = ?
                                         ├─ 'agree'      → 本次执行 ✓
                                         ├─ 'allow'      → 执行 ✓ + 持久化权限
                                         │                 （文件编辑：grantGlobalEditPermission；
                                         │                  Bash/Skill/MCP：写入 allowedTools）
                                         ├─ 'refuse'     → 中断 + 返回拒绝原因给 LLM
                                         └─ 其他字符串  → 返回反馈文本给 LLM（不中断）
```

**文件编辑权限说明**：用户选择 `'allow'` 后，`hasGlobalEditPermission` 置为 `true`，整个会话内项目目录下的文件编辑不再询问；项目目录外的文件仍会再次请求权限。新会话（`setSessionId`）会自动重置该权限。


## Bash 安全命令白名单

以下命令被视为安全命令，无需权限直接执行：

```
git status, git diff, git log, git branch,
pwd, tree, date, which,
ls, find, grep, head, tail, cat, du, wc, echo, env, printenv
```

**管道命令（`|`）**：每一段的主命令均须在白名单内，才可整体直接执行。

**链式命令（`&&`、`||`、`;`）**：不做前缀匹配，对每个子命令单独分析。


## allowedTools 格式

持久化到 `projectConfig.allowedTools[]` 的权限记录格式：

| 格式 | 含义 |
|------|------|
| `'Bash(npm run:*)'` | 允许以 `npm run` 开头的所有 Bash 命令（前缀匹配） |
| `'Bash(git status)'` | 仅允许 `git status` 这一条完整命令 |
| `'Skill(commit)'` | 允许调用 `commit` Skill |
| `'mcp__fs_read_file'` | 允许调用特定 MCP 工具 |

> 文件编辑权限（Edit / Write / NotebookEdit）以会话级 `globalEditPermission` 标志控制，不写入 `allowedTools`。


## 交互式工具事件

除工具权限外，以下两类工具在执行时也会暂停等待用户响应，需通过对应的响应接口回传结果。

### AskUserQuestion — 向用户提问

AI 调用 `AskUserQuestion` 工具时，Core 会触发 `ask:question:request` 事件，UI 层需展示问题并通过 `respondToAskQuestion()` 回传答案。

**事件流程：**

```
AI 调用 AskUserQuestion
        │
        ▼
emit ask:question:request
        │
    等待 respondToAskQuestion()
        │
    answers = { [question]: answer, ... }
        │  （多选时 answer 为逗号分隔的字符串）
        ▼
    继续 AI 执行
```

**`ask:question:request` 事件数据结构：**

```typescript
interface AskQuestionRequestData {
  agentId: string;       // 代理ID
  questions: Array<{
    question: string;    // 问题内容（以问号结尾）
    header: string;      // 简短标签（最多 12 字符）
    options: Array<{
      label: string;     // 选项显示文本（1-5 词）
      description: string; // 选项说明
    }>;                  // 2-4 个选项
    multiSelect: boolean; // 是否允许多选
  }>;                    // 1-4 个问题
  metadata?: {
    source?: string;     // 问题来源标识
  };
}
```

**`respondToAskQuestion()` 响应数据结构：**

```typescript
interface AskQuestionResponseData {
  agentId: string;                    // 与请求中的 agentId 保持一致
  answers: Record<string, string>;    // { [question 文本]: 选中的 label }
                                      // 多选时 value 为逗号分隔的 label 列表
}
```

---

### ExitPlanMode — 退出 Plan 模式

AI 在 Plan 模式下完成规划后调用 `ExitPlanMode` 工具，Core 会触发 `plan:exit:request` 事件，UI 层需展示计划内容并让用户选择如何继续，然后通过 `respondToPlanExit()` 回传选择。

**事件流程：**

```
AI 调用 ExitPlanMode（含 planFilePath）
        │
        ▼
emit plan:exit:request（含计划文件内容）
        │
    等待 respondToPlanExit()
        │
    selected = ?
    ├─ 'startEditing'         → 退出 Plan 模式，保留上下文，继续编码
    └─ 'clearContextAndStart' → 退出 Plan 模式，清空上下文
                                 + emit plan:implement（含计划内容）
                                 + 以 "Implement the following plan:..." 重建消息历史
```

**`plan:exit:request` 事件数据结构：**

```typescript
interface PlanExitRequestData {
  agentId: string;       // 代理ID
  planFilePath: string;  // 计划文件相对路径
  planContent: string;   // 计划文件 .md 内容
  options: {
    startEditing: string;           // 选项描述文本
    clearContextAndStart: string;   // 选项描述文本
  };
}
```

**`respondToPlanExit()` 响应数据结构：**

```typescript
interface PlanExitResponseData {
  agentId: string;       // 与请求中的 agentId 保持一致
  selected: 'startEditing' | 'clearContextAndStart';
}
```

**`plan:implement` 事件**（仅当 `selected === 'clearContextAndStart'` 时触发）：

```typescript
interface PlanImplementData {
  planFilePath: string;  // 计划文件相对路径
  planContent: string;   // 计划文件 .md 内容
}
```

> UI 层可监听 `plan:implement` 事件做额外处理（如跳转视图、清空聊天记录），但无需回传响应。


## 响应接口汇总

SemaCore 提供三个响应方法，分别对应三类等待用户交互的场景：

| 方法 | 对应事件 | 说明 |
|------|---------|------|
| `respondToToolPermission(response)` | `tool:permission:request` | 回传工具权限选择 |
| `respondToAskQuestion(response)` | `ask:question:request` | 回传用户问题答案 |
| `respondToPlanExit(response)` | `plan:exit:request` | 回传 Plan 模式退出选择 |

> 三类事件均包含 `agentId` 字段，响应时须原样回传，以确保 Core 正确路由到发起请求的代理实例。


## 代码示例

### 实现权限处理器

```javascript
sema.on('tool:permission:request', ({ toolName, title, content, options }) => {
  // 显示权限请求 UI
  console.log(`\n⚠️  权限请求: ${title}`)

  // 如果包含 diff 内容，展示变更预览
  if (content?.type === 'diff') {
    showDiffPreview(content.patch)
  }

  // 获取用户选择
  const choice = await promptUser(options)

  sema.respondToToolPermission({
    toolName,
    selected: choice,  // 'agree' | 'allow' | 'refuse'
  })
})
```

### 实现问答处理器

```javascript
sema.on('ask:question:request', ({ agentId, questions }) => {
  // 展示问题列表，等待用户选择
  const answers = await showQuestionUI(questions)
  // answers 示例: { "Which library should we use?": "React" }

  sema.respondToAskQuestion({ agentId, answers })
})
```

### 实现 Plan 模式退出处理器

```javascript
sema.on('plan:exit:request', ({ agentId, planContent, options }) => {
  // 展示计划内容，让用户选择操作
  showPlanPreview(planContent)
  const selected = await promptUser(options)
  // selected: 'startEditing' | 'clearContextAndStart'

  sema.respondToPlanExit({ agentId, selected })
})

// 监听 plan:implement（选择清空上下文时触发）
sema.on('plan:implement', ({ planContent }) => {
  clearChatHistory()
})
```

### 自动同意所有权限请求（开发/测试用）

```javascript
sema.on('tool:permission:request', ({ toolName }) => {
  sema.respondToToolPermission({ toolName, selected: 'allow' })
})
```

### 按工具类型差异化处理

```javascript
sema.on('tool:permission:request', ({ toolName, title }) => {
  // 文件编辑：自动允许
  if (toolName === 'Edit' || toolName === 'Write') {
    sema.respondToToolPermission({ toolName, selected: 'allow' })
    return
  }

  // Bash 命令：需要用户确认
  if (toolName === 'Bash') {
    const confirmed = await confirm(`执行命令: ${title}?`)
    sema.respondToToolPermission({
      toolName,
      selected: confirmed ? 'allow' : 'refuse',
    })
    return
  }

  // 其他：默认同意本次
  sema.respondToToolPermission({ toolName, selected: 'agree' })
})
```

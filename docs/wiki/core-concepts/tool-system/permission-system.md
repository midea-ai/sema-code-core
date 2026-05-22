# 权限系统

权限系统确保 AI 在执行可能影响系统状态的操作前获得用户授权。

## 权限类型

| 类型 | 控制配置 | 默认行为 | 持久化格式 |
|------|---------|---------|-----------|
| 文件编辑 | `skipFileEditPermission` | 需要确认 | 会话级授权（不写入 allowedTools） |
| 终端执行 | `skipShellExecPermission` | 需要确认 | `'run_shell(命令前缀:*)'` 或 `'run_shell(完整命令)'` |
| Skill 调用 | `skipSkillPermission` | 需要确认 | `'Skill(name)'` |
| MCP 工具 | `skipMCPToolPermission` | 需要确认 | `'mcp__server_tool'` |
| Fetch Url | `skipFetchUrlPermission` | 需要确认 | `'fetch_url(domain)'` |


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
                         └─ 否 → 安全命令白名单？（仅 RunShell）
                                   ├─ 是 → 直接执行 ✓
                                   └─ 否 → emit tool:permission:request
                                             │
                                             ▼
                                         等待 session.respondToToolPermission()
                                             │
                                         selected = ?
                                         ├─ 'agree'      → 本次执行 ✓
                                         ├─ 'allow'      → 执行 ✓ + 持久化权限
                                         │                 （文件编辑：grantGlobalEditPermission；
                                         │                  run_shell/Skill/MCP/fetch_url：写入 allowedTools）
                                         ├─ 'refuse'     → 中断 + 返回拒绝原因给 LLM
                                         └─ 其他字符串  → 返回反馈文本给 LLM（不中断）
```

**文件编辑权限说明**：用户选择 `'allow'` 后，当前 `SemaSession` 的 `hasGlobalEditPermission` 置为 `true`，该会话内项目目录下的文件编辑不再询问；项目目录外的文件仍会再次请求权限。关闭会话或新建会话后，该授权不会继承。


## `run_shell` 安全命令白名单

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
| `'run_shell(npm run:*)'` | 允许以 `npm run` 开头的所有 `run_shell` 命令（前缀匹配） |
| `'run_shell(git status)'` | 仅允许 `git status` 这一条完整命令 |
| `'Skill(commit)'` | 允许调用 `commit` Skill |
| `'mcp__fs_read_file'` | 允许调用特定 MCP 工具 |
| `'fetch_url(example.com)'` | 允许对 `example.com` 域名的 `fetch_url` 请求 |

> 文件编辑权限（`patch_file` / `write_file` / `edit_notebook`）以会话级 `globalEditPermission` 标志控制，不写入 `allowedTools`。


## 交互式工具事件

除工具权限外，以下两类工具在执行时也会暂停等待用户响应，需通过对应的响应接口回传结果。

### AskForm — 向用户提问

AI 调用 `ask_form` 工具时，当前会话会触发 `pick:option:request` 事件，UI 层需展示表单并通过 `session.respondToPickOption()` 回传答案。

**事件流程：**

```
AI 调用 ask_form
        │
        ▼
emit pick:option:request
        │
    等待 session.respondToPickOption()
        │
    answers = "- 问题标签: 答案\n..."
        │  （取消整个表单时 answers 为 null）
        ▼
    继续 AI 执行
```

**`pick:option:request` 事件数据结构：**

```typescript
interface PickOptionRequestData {
  agentId: string;                 // 代理 ID
  questions: PickOptionQuestion[]; // 问题列表（1-7 个）
  estimatedTime?: string;          // UI 展示的预计填写时间，如 "~30 sec"
  intro?: string;                  // 表单引导语
}

type PickOptionQuestion =
  | { type: 'radio'; id: string; label: string; required?: boolean; options: string[] }
  | { type: 'checkbox'; id: string; label: string; required?: boolean; options: string[]; maxSelections?: number }
  | { type: 'select'; id: string; label: string; required?: boolean; options: string[] }
  | { type: 'text'; id: string; label: string; required?: boolean; placeholder?: string }
  | { type: 'textarea'; id: string; label: string; required?: boolean; placeholder?: string }
}
```

**`respondToPickOption()` 响应数据结构：**

```typescript
interface PickOptionResponseData {
  agentId: string;          // 与请求中的 agentId 保持一致
  answers: string | null;   // 前端预格式化的纯文本答案；null 表示用户取消整个表单
}
```

---

### PlanToAgent — 退出 Plan 模式

AI 在 Plan 模式下完成规划后调用 `PlanToAgent` 工具，当前会话会触发 `plan:exit:request` 事件，UI 层需展示计划内容并让用户选择如何继续，然后通过 `session.respondToPlanExit()` 回传选择。

**事件流程：**

```
AI 调用 PlanToAgent（含 planFilePath）
        │
        ▼
emit plan:exit:request（含计划文件内容）
        │
    等待 session.respondToPlanExit()
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

`SemaSession` 提供三个响应方法，分别对应三类等待用户交互的场景：

| 方法 | 对应事件 | 说明 |
|------|---------|------|
| `session.respondToToolPermission(response)` | `tool:permission:request` | 回传工具权限选择 |
| `session.respondToPickOption(response)` | `pick:option:request` | 回传用户问题答案 |
| `session.respondToPlanExit(response)` | `plan:exit:request` | 回传 Plan 模式退出选择 |

> 响应必须在发起请求的 `SemaSession` 上发送。`pick` 和 `plan` 响应需原样回传 `agentId`；工具权限响应需回传 `toolId` 和 `toolName`，以精确匹配同时存在的请求。


## 代码示例

### 实现权限处理器

```javascript
session.on('tool:permission:request', ({ toolId, toolName, title, content, options }) => {
  // 显示权限请求 UI
  console.log(`\n⚠️  权限请求: ${title}`)

  // 如果包含 diff 内容，展示变更预览
  if (content?.type === 'diff') {
    showDiffPreview(content.patch)
  }

  // 获取用户选择
  const choice = await promptUser(options)

  session.respondToToolPermission({
    toolId,
    toolName,
    selected: choice,  // 'agree' | 'allow' | 'refuse'
  })
})
```

### 实现问答处理器

```javascript
session.on('pick:option:request', ({ agentId, questions, estimatedTime, intro }) => {
  // 展示表单，等待用户提交或取消
  const answers = await showFormUI({ questions, estimatedTime, intro })
  // answers 示例: "- Framework: React\n- Features: Auth; Billing"
  // 用户取消整个表单时返回 null

  session.respondToPickOption({ agentId, answers })
})
```

### 实现 Plan 模式退出处理器

```javascript
session.on('plan:exit:request', ({ agentId, planContent, options }) => {
  // 展示计划内容，让用户选择操作
  showPlanPreview(planContent)
  const selected = await promptUser(options)
  // selected: 'startEditing' | 'clearContextAndStart'

  session.respondToPlanExit({ agentId, selected })
})

// 监听 plan:implement（选择清空上下文时触发）
session.on('plan:implement', ({ planContent }) => {
  clearChatHistory()
})
```

### 自动同意所有权限请求（开发/测试用）

```javascript
session.on('tool:permission:request', ({ toolId, toolName }) => {
  session.respondToToolPermission({ toolId, toolName, selected: 'allow' })
})
```

### 按工具类型差异化处理

```javascript
session.on('tool:permission:request', ({ toolId, toolName, title }) => {
  // 文件编辑：自动允许
  if (toolName === 'patch_file' || toolName === 'write_file') {
    session.respondToToolPermission({ toolId, toolName, selected: 'allow' })
    return
  }

  // RunShell 命令：需要用户确认
  if (toolName === 'run_shell') {
    const confirmed = await confirm(`执行命令: ${title}?`)
    session.respondToToolPermission({
      toolId,
      toolName,
      selected: confirmed ? 'allow' : 'refuse',
    })
    return
  }

  // 其他：默认同意本次
  session.respondToToolPermission({ toolId, toolName, selected: 'agree' })
})
```

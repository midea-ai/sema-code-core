# 交互式工具事件

除工具权限外（见[工具权限检查](shell-check)），以下两类工具在执行时也会暂停等待用户响应，需通过对应的响应接口回传结果。

## AskForm — 向用户提问

AI 调用 `ask_form` 工具时，当前会话会触发 `pick:option:request` 事件，UI 层需展示表单并通过 `session.respondToPickOption()` 回传答案。

```
AI 调用 ask_form → emit pick:option:request
        → 等待 session.respondToPickOption()
        → answers = "- 问题标签: 答案\n..."（取消整个表单时为 null）
        → 继续 AI 执行
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
```

**`respondToPickOption()` 响应数据结构：**

```typescript
interface PickOptionResponseData {
  agentId: string;          // 与请求中的 agentId 保持一致
  answers: string | null;   // 前端预格式化的纯文本答案；null 表示用户取消整个表单
}
```

## PlanToAgent — 退出 Plan 模式

AI 在 Plan 模式下完成规划后调用 `PlanToAgent` 工具，当前会话会触发 `plan:exit:request` 事件，UI 层需展示计划内容并让用户选择如何继续，然后通过 `session.respondToPlanExit()` 回传选择。

```
AI 调用 PlanToAgent（含 planFilePath）→ emit plan:exit:request（含计划文件内容）
        → 等待 session.respondToPlanExit()
        → selected = ?
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
>
> `tool:permission:auto` 与 `permissionLevel:update` 是单向通知事件（见[权限系统概述](overview)），无对应响应方法。

## 代码示例

### 实现问答处理器

```javascript
session.on('pick:option:request', async ({ agentId, questions, estimatedTime, intro }) => {
  const answers = await showFormUI({ questions, estimatedTime, intro })
  // answers 示例: "- Framework: React\n- Features: Auth; Billing"；用户取消返回 null
  session.respondToPickOption({ agentId, answers })
})
```

### 实现 Plan 模式退出处理器

```javascript
session.on('plan:exit:request', async ({ agentId, planContent, options }) => {
  showPlanPreview(planContent)
  const selected = await promptUser(options)  // 'startEditing' | 'clearContextAndStart'
  session.respondToPlanExit({ agentId, selected })
})

session.on('plan:implement', ({ planContent }) => {
  clearChatHistory()
})
```

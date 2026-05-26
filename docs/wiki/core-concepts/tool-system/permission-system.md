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
               ├─ 是 → 档位非 Ask（AutoEdit / AutoRun）？
               │         ├─ 是 → 项目目录内？
               │         │         ├─ 是 → 直接执行 ✓
               │         │         └─ 否 → 请求权限 *
               │         └─ 否 → 请求权限 *
               └─ 否 → allowedTools 已记录 / 安全命令白名单？（白名单仅 RunShell）
                         ├─ 是 → 直接执行 ✓
                         └─ 否 → 请求权限 *

* 请求权限：AutoRun 档位下，先做自动安全判断（见下），判定安全则直接放行；
  否则 emit tool:permission:request 并等待 session.respondToToolPermission()
       │
   selected = ?
   ├─ 'agree'      → 本次执行 ✓
   ├─ 'allow'      → 执行 ✓ + 持久化权限
   │                 （文件编辑：档位提升至 AutoEdit；
   │                  run_shell/Skill/MCP/fetch_url：写入 allowedTools）
   ├─ 'refuse'     → 中断 + 返回拒绝原因给 LLM
   └─ 其他字符串  → 返回反馈文本给 LLM（不中断）
```

**文件编辑权限说明**：用户选择 `'allow'` 后，当前 `SemaSession` 的权限档位提升至 `'AutoEdit'`（已是 `'AutoEdit'` / `'AutoRun'` 则保持不变），该会话内项目目录下的文件编辑不再询问；项目目录外的文件仍会再次请求权限。关闭会话或新建会话后，该档位不会继承。

## 权限自由度档位（会话级）

每个 `SemaSession` 持有一个权限自由度档位，控制需要确认的工具被自动放行的力度。档位由 `createSession({ permissionLevel })` 指定初始值（默认 `'Ask'`），运行中通过 `session.updatePermissionLevel(level)` 调整，变更时触发 `permissionLevel:update` 事件。

| 档位 | 自由度 | 行为 |
|------|--------|------|
| `'Ask'` | 最低 | 每个需要确认的动作都弹窗询问 |
| `'AutoEdit'` | 中 | 项目目录内的文件编辑自动放行，其余动作仍询问 |
| `'AutoRun'` | 最高 | 在发出人工权限申请前先做自动安全判断，判定安全则放行，否则转人工 |

> 档位只能由用户显式提升或在文件编辑弹窗选择 `'allow'` 时从 `'Ask'` 提升到 `'AutoEdit'`；已是 `'AutoEdit'` / `'AutoRun'` 时不会被自动降级。

### AutoRun 自动安全判断

`AutoRun` 档位下，动作在转人工之前先经过一道自动判断，按工具类型分流：

- **文件编辑**：确定性判断，不走模型。项目目录内放行，项目目录外转人工。
- **Skill**：放行（仅注入提示词；技能内的真实动作会作为下游工具再次过权限闸门）。
- **MCP 工具**：转人工（外部不可逆副作用，语义对模型不透明）。
- **fetch_url**：先做确定性 SSRF 兜底——命中环回（`127.0.0.0/8`、`::1`）、链路本地（`169.254.0.0/16`，含云元数据 `169.254.169.254`）、内网（`10/8`、`172.16/12`、`192.168/16`、`100.64/10`）、`localhost`、`metadata.google.internal` 等一律转人工，不交给模型；未命中再交由快速模型判断。
- **run_shell 及其余动作**：交给快速模型（`quick` 指针）判断 `safe` / `risky`。仅当模型明确返回 `safe` 时放行；其余情况（解释性文本、空响应、API 错误、超时、中断）一律失败关闭，转人工。

> 安全判断以**当前执行代理自身**的会话历史作为上下文旁路调用模型，绝不写回会话历史——子代理使用子代理自己的上下文，而非主代理。


## `run_shell` 命令权限检查

`run_shell` 的权限检查按固定顺序执行，任一环节放行即直接执行，否则继续下探，最终转人工。

### 检查顺序

1. **剥离 cwd 前缀**：去掉命令开头的 `cd <项目根目录> && `，避免该前缀干扰后续匹配。
2. **命令注入检测（最先执行，fail-closed）**：用 `splitCommand` 按 `&&`、`||`、`;`、管道等拆分为子命令，逐个用 `hasCommandInjection` 检测。任一子命令命中注入特征即转人工，且**不提供「永久允许」选项，仅允许单次确认**。
   > 注入检测必须先于白名单与 AutoRun，否则像 `echo $(id)` 这类「白名单主命令词夹带命令替换」的命令会绕过检查。
3. **白名单 / 精确授权命中**：整条命令命中 `SAFE_COMMANDS` 白名单，或已记录在 `allowedTools` 中 → 直接执行。
4. **AutoRun 自动安全判断**：`AutoRun` 档位下，对整条命令调一次快速模型判断；判定 `safe` 直接放行，判定有风险则继续下探（已保存授权仍可放行），仍不覆盖才转人工。
5. **子命令逐条覆盖**：每个子命令都被 `SAFE_COMMANDS`、精确授权或已保存前缀（`run_shell(前缀:*)`）覆盖 → 直接执行。
6. **转人工 + 前缀提取**：仍未覆盖时转人工，并对「首个未被覆盖的子命令」调一次快速模型提取前缀，用于人工弹窗的「按前缀授权」选项。

### 安全命令白名单

以下命令被视为安全命令，无需权限直接执行：

```
git status, git diff, git log, git branch,
pwd, tree, date, which,
ls, find, grep, head, tail, cat, du, wc, echo, env, printenv
```

**管道命令（`|`）**：每一段的主命令均须在白名单内，才可整体直接执行。

**链式命令（`&&`、`||`、`;`）**：不做前缀匹配，按检查顺序拆分子命令逐条判定。

### 命令注入特征

`hasCommandInjection` 命中以下任一字符 / 组合即视为注入（与前缀提取提示词的判定保持一致）：

```
`  (反引号)    \n (换行)    ;
$(            &&            ||
```

### 前缀提取与「永久允许」选项

转人工时，是否提供「永久允许」取决于对**首个未被覆盖子命令**的前缀提取结果：

| 提取结果 | 弹窗选项 | 选 `allow` 后写入 `allowedTools` |
|---------|---------|------------------------------|
| 提取到有效前缀 | 确认 / 按前缀授权 / 拒绝 | `run_shell(前缀:*)` |
| 模型调用失败，且整条命令不超长 | 确认 / 精确命令授权 / 拒绝 | `run_shell(完整命令)` |
| 检出注入 / 返回 `none` / 返回 `git`（如 `git push`） | 确认 / 拒绝（无永久允许） | — |
| 子命令超长（`> 512` 字符，如 `python -c "..."`） | 确认 / 拒绝（无永久允许） | — |

> **为何用首个未覆盖子命令而非整条命令做前缀提取**：整条复合命令含 `&&` / `||` / `;`，会被前缀提取提示词判为注入，提取不到前缀。
>
> **超长跳过（`MAX_PREFIX_EXTRACT_LEN = 512`）**：内联脚本等超长命令提取前缀无意义；超限仅丢失「按前缀授权」便利，命令本身仍可单次确认执行。
>
> 已保存的前缀授权（`run_shell(前缀:*)`）由确定性字符串前缀匹配（`matchesSavedPrefix`）判定覆盖，**不再为此调用模型**。


## allowedTools 格式

持久化到 `projectConfig.allowedTools[]` 的权限记录格式：

| 格式 | 含义 |
|------|------|
| `'run_shell(npm run:*)'` | 允许以 `npm run` 开头的所有 `run_shell` 命令（前缀匹配） |
| `'run_shell(git status)'` | 仅允许 `git status` 这一条完整命令 |
| `'Skill(commit)'` | 允许调用 `commit` Skill |
| `'mcp__fs_read_file'` | 允许调用特定 MCP 工具 |
| `'fetch_url(example.com)'` | 允许对 `example.com` 域名的 `fetch_url` 请求 |

> 文件编辑权限（`patch_file` / `write_file` / `edit_notebook`）以会话级权限档位控制（档位为 `'AutoEdit'` / `'AutoRun'` 时项目目录内自动放行），不写入 `allowedTools`。


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

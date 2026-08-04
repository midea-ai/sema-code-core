# Hook 使用

Hook 是挂在 agent 循环关键节点上的外部命令：在会话开始、用户输入、工具执行等时机自动运行你的脚本，脚本通过 exit code 与 stdout JSON 反过来影响循环——拦截危险操作（门禁）、给模型补充信息（注入）、记录审计日志（观察）。事件名、stdin payload、输出协议与业界通用的 hooks 格式保持一致，已有的同格式 hook 脚本大多可直接复用。

## 配置文件

支持用户级和项目级两份配置，按用户级 → 项目级顺序加载，同一事件的条目依次执行：

| 来源 | 路径 |
|------|------|
| 用户级 | `~/.sema/hooks/hooks.json` |
| 项目级 | `<workingDir>/.sema/hooks/hooks.json` |

hook 脚本建议与配置同目录存放（如 `.sema/hooks/check.js`），配置中以相对项目根的路径引用。配置在 Core 初始化时后台加载；调用 `getHooksInfo(true)` 可重新加载，下一次 hook 触发即生效。

## 配置格式

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node .sema/hooks/check-shell.js", "timeout": 10 }
        ]
      }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "cat .sema/hooks/context.md" }] }
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `matcher` | 工具名匹配（仅工具类事件有效）：缺省或 `*` 全匹配；`Bash\|Edit` 精确集合（通用工具名与内置名均可命中）；其他写法按正则匹配通用工具名 |
| `type` | 目前仅支持 `command`，其他类型的条目跳过 |
| `command` | 经系统 shell 执行的命令，payload 从 stdin 传入（JSON） |
| `timeout` | 超时秒数，默认 60；超时进程被终止并发 `hook:notice` 告警 |
| `failClosed` | sema 扩展：hook 执行失败（非 0/2 退出、超时、spawn 失败）时按阻断处理，缺省 `false`（fail-open） |

含 `if` 字段的条目（条件过滤，暂不支持）整条跳过，状态可在 `getHooksInfo` 视图中看到。

## 支持的事件

| 事件 | 触发点 | 能力 |
|------|--------|------|
| `SessionStart` | 会话初始化成功后 | 注入（stdout / `additionalContext` 进模型上下文，首轮消费一次） |
| `UserPromptSubmit` | 用户输入进入处理前 | 门禁（exit 2 丢弃本次输入）+ 注入；静默输入（后台/定时任务通知)不触发 |
| `PreToolUse` | 工具执行前 | 门禁（`deny` 拦截工具并回给模型；`allow` 跳过权限询问直接执行） |
| `PostToolUse` | 工具执行成功后 | 注入（`additionalContext` 与 exit 2 的 stderr 回灌模型） |
| `PostToolUseFailure` | 工具执行抛错后 | 注入（可注入纠错提示） |
| `PermissionRequest` | 权限系统即将询问用户前 | 门禁（`allow` 等价用户同意、不落永久授权；`deny` 拒绝单个动作、不中断 turn） |
| `Stop` | 一轮处理自然完成转 idle 时 | 仅观察（完成通知、审计日志）；中断与排队接续的轮次不触发 |
| `SessionEnd` | 会话关闭时 | 仅观察，fire-and-forget |

子 agent（task）内的工具调用同样触发工具类事件，payload 以 `agent_id` 区分主/子。`SessionStart` / `SessionEnd` / `Stop` 不可阻断，block 输出被忽略（`Stop` 额外发告警提示配置未生效）。

## 输入（stdin payload）

公共字段：`session_id`、`cwd`、`hook_event_name`、`agent_id`。事件专属字段：

| 字段 | 提供事件 |
|------|---------|
| `prompt` | `UserPromptSubmit` |
| `tool_name`（通用工具名，如 `Bash` / `Edit`）、`sema_tool_name`（内置名）、`tool_input` | 四个工具类事件 |
| `tool_response` | `PostToolUse` |
| `error` | `PostToolUseFailure` |
| `source`（固定 `startup`） | `SessionStart` |
| `reason`（固定 `dispose`） | `SessionEnd` |
| `stop_hook_active`（恒 `false`） | `Stop` |

工具名映射举例：`run_shell` → `Bash`、`patch_file` → `Edit`、`view_file` → `Read`；MCP 工具保持 `mcp__server__tool` 原名。

## 输出协议

exit code 与 stdout JSON 两条通道：

| Exit code | 行为 |
|---:|---|
| `0` | 继续；stdout 为合法 JSON 对象则结构化解析，`SessionStart` / `UserPromptSubmit` 的纯文本 stdout 直接作为上下文注入 |
| `2` | 阻断，stderr 作为原因（PreToolUse 拦工具 / UserPromptSubmit 丢输入 / PermissionRequest 拒授权；PostToolUse 已无法撤销，stderr 回灌模型） |
| 其他 | hook 执行失败，默认不阻断（fail-open），配置 `failClosed` 后按阻断处理 |

JSON 字段（exit 0 时）：

| 字段 | 说明 |
|------|------|
| `decision: "block"` + `reason` | 阻断当前动作（语义同 exit 2） |
| `systemMessage` | 经 `hook:notice` 事件展示给用户，不进模型上下文 |
| `hookSpecificOutput.permissionDecision` | `allow` / `deny` / `ask`，仅 `PreToolUse` / `PermissionRequest` |
| `hookSpecificOutput.additionalContext` | 注入模型上下文（上限 10k 字符，超出截断） |

改写类能力（`updatedInput`）、全停指令（`continue` / `stopReason`）、`Stop` 续驱（block 阻止 turn 结束）不支持。

## 示例

按事件各给一个可直接落地的例子，含配置、脚本与对模型消息的实际影响。

### SessionStart —— 会话启动注入

```json
{ "hooks": { "SessionStart": [ { "hooks": [{ "type": "command", "command": "node .sema/hooks/session-start.js" }] } ] } }
```

```js
// session-start.js
console.log('本项目内部代号：蓝鲸计划；今日部署冻结，禁止 push');
```

用户输入：*我们项目的内部代号是什么？* 注入内容包 reminder 壳，挂在首轮用户消息的文本之前（仅首轮一次，compact/fork 后不重复）：

```json
[
  { "type": "text", "text": "<reminder-sys>\nSessionStart hook context:\n本项目内部代号：蓝鲸计划；今日部署冻结，禁止 push\n</reminder-sys>" },
  { "type": "text", "text": "我们项目的内部代号是什么？" }
]
```

模型据此答出"蓝鲸计划"——该信息不在任何文件或 prompt 里，来自 hook 注入。

### UserPromptSubmit —— 输入门禁与注入

```json
{ "hooks": { "UserPromptSubmit": [ { "hooks": [{ "type": "command", "command": "node .sema/hooks/guard.js" }] } ] } }
```

```js
// guard.js
const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
if ((i.prompt || '').includes('FORBIDDEN')) { console.error('输入触发安全策略，已拦截'); process.exit(2); }
if ((i.prompt || '').includes('翻译')) console.log('翻译风格要求：口语化');
```

**block 分支**——用户输入：*处理一下这段 FORBIDDEN 内容*。该输入被丢弃，不产生任何模型调用；stderr 经 `hook:notice` 展示给用户：

```json
{ "kind": "blocked", "hookEvent": "UserPromptSubmit", "message": "输入触发安全策略，已拦截" }
```

**注入分支**——用户输入：*把 hello world 翻译成中文*。上下文挂在该条输入自己的消息上：

```json
[
  { "type": "text", "text": "<reminder-sys>\nUserPromptSubmit hook context:\n翻译风格要求：口语化\n</reminder-sys>" },
  { "type": "text", "text": "把 hello world 翻译成中文" }
]
```

### PreToolUse —— 工具门禁（同一事件两条 hook：门禁 + 审计）

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
  { "type": "command", "command": "node .sema/hooks/tool-guard.js", "timeout": 5 },
  { "type": "command", "command": "node .sema/hooks/audit.js" }
] } ] } }
```

```js
// tool-guard.js：git push → deny（配合 SessionStart 的部署冻结设定）；hook_ok → allow；其余不表态走原权限流程
// 注意别用 curl/wget 等验证：它们在内置命令黑名单里，入参校验阶段就被拒，到不了 hook
const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const cmd = i.tool_input?.command || '';
const out = (pd, r) => console.log(JSON.stringify({ hookSpecificOutput:
  { hookEventName: 'PreToolUse', permissionDecision: pd, permissionDecisionReason: r } }));
if (cmd.includes('git push')) out('deny', '今日部署冻结，禁止 push，请明天再试');
else if (cmd.includes('hook_ok')) out('allow', '');
```

```js
// audit.js：观察类，零输出，把每次命令追加写入审计日志
const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
require('fs').appendFileSync('/tmp/hook_audit.log', `${i.agent_id} ${i.tool_input?.command}\n`);
```

**deny**——用户输入：*终端直接运行 git push origin main*。模型发出 tool_use 后，工具不执行、无权限弹窗，拒绝原因以 `is_error` 工具结果回给模型（模型不知道是 hook 拦的，会换方案或转告用户）；第一条 deny 后第二条审计 hook 被短路，审计文件无新行：

```json
[ { "type": "tool_result", "tool_use_id": "toolu_xx", "is_error": true, "content": "今日部署冻结，禁止 push，请明天再试" } ]
```

**allow**——用户输入：*执行 touch /tmp/hook_ok.txt*（命令里含 `hook_ok` 即命中）。跳过权限询问直接执行（`PermissionRequest` hook 也不触发），发给模型的消息与用户手动点"同意"后完全一致，模型无感知；allow 不是阻断，审计 hook 照常执行，审计文件新增一行：

```
main touch /tmp/hook_ok.txt
```

**不表态**——用户输入：*执行 git status*。tool-guard 零输出不表态，两条 hook 都跑完（审计落一行 `main git status`），然后走原权限询问流程，同意后正常执行，对模型消息零影响——和没配这条 hook 时的唯一区别就是审计文件多了一行。

### PermissionRequest —— 权限自动裁决

```json
{ "hooks": { "PermissionRequest": [ { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node .sema/hooks/perm.js" }] } ] } }
```

```js
// perm.js：hook_perm → 免询问放行（等价用户 agree，不落盘永久授权）；
// npm publish → 免询问拒绝（走自定义反馈通道，turn 不中断，模型收到拒绝理由可换方案）
const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const cmd = i.tool_input?.command || '';
const out = (pd, r) => console.log(JSON.stringify({ hookSpecificOutput:
  { hookEventName: 'PermissionRequest', permissionDecision: pd, ...(r && { permissionDecisionReason: r }) } }));
if (cmd.includes('hook_perm')) out('allow');
else if (cmd.includes('npm publish')) out('deny', '发布操作需要走 CI 流水线，禁止本地 publish');
```

**allow**——用户输入：*执行 mkdir -p /tmp/hook_perm*。不弹权限询问，等价用户点了"同意"（但不落盘永久授权），模型看到正常执行结果。

**deny**——用户输入：*执行 npm publish --dry-run*。不弹询问、turn 不中断（区别于用户手点"拒绝"会中断整个 turn），模型收到的是"用户拒绝并给出理由"的反馈，可继续换方案：

```json
[ { "type": "tool_result", "tool_use_id": "toolu_xx", "is_error": true,
    "content": "User has rejected this action. To explain the next steps, the user said:\n发布操作需要走 CI 流水线，禁止本地 publish" } ]
```

### PostToolUse —— 结果附加说明

```json
{ "hooks": { "PostToolUse": [ { "matcher": "Read", "hooks": [{ "type": "command", "command": "node .sema/hooks/post-read.js" }] } ] } }
```

```js
// post-read.js：读 package.json → 注入"改动需同步更新 SDK 文档"提醒；
// 读敏感配置（.env/secret/credential）→ 注入"禁止复述密钥"提醒；其余文件零输出不干预
const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const f = i.tool_input?.file_path || '';
const inject = t => console.log(JSON.stringify({ hookSpecificOutput:
  { hookEventName: 'PostToolUse', additionalContext: t } }));
if (f.endsWith('package.json')) inject('提醒：本项目文件修改后需同步更新 SDK 文档');
else if (/\.env|secret|credential/i.test(f)) inject('刚读取的是敏感配置文件，禁止在回复中原样复述密钥/令牌内容');
```

**注入（package.json）**——用户输入：*读一下 package.json*。工具正常执行，注入内容以 reminder 块追加在 `tool_result` 之后（同一条消息内）：

```json
[
  { "type": "tool_result", "tool_use_id": "toolu_xx", "content": "<package.json 内容>" },
  { "type": "text", "text": "<reminder-sys>\n提醒：本项目文件修改后需同步更新 SDK 文档\n</reminder-sys>" }
]
```

**注入（敏感文件）**——用户输入：*读一下 .env*。工具正常执行，追加的是另一条文案；可以观察模型行为差异：被提醒后会避免把密钥值原样贴进回复。

### PostToolUseFailure —— 失败纠错注入

```json
{ "hooks": { "PostToolUseFailure": [ { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node .sema/hooks/fail-hint.js" }] } ] } }
```

```js
// fail-hint.js：python 命令失败时注入纠错提示，帮模型换 python3 重试
const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));
if ((i.tool_input?.command || '').includes('python '))
  console.log(JSON.stringify({ hookSpecificOutput:
    { hookEventName: 'PostToolUseFailure', additionalContext: '本机没有 python，请改用 python3' } }));
```

用户输入：*执行 python --version*（本机无 python）。工具失败，纠错提示追加在错误结果之后，模型看到后自动改用 python3 重试，无需用户介入：

```json
[
  { "type": "tool_result", "tool_use_id": "toolu_xx", "is_error": true, "content": "command not found: python" },
  { "type": "text", "text": "<reminder-sys>\n本机没有 python，请改用 python3\n</reminder-sys>" }
]
```

### Stop —— 完成通知

```json
{ "hooks": { "Stop": [ {
  "hooks": [{ "type": "command", "command": "osascript -e 'display notification \"任务完成\" with title \"Sema\"'" }]
} ] } }
```

一轮处理自然完成转 idle 时弹系统通知；纯观察，对模型消息零影响。

### SessionEnd —— 会话收尾审计

```json
{ "hooks": { "SessionEnd": [ { "hooks": [{ "type": "command", "command": "node .sema/hooks/session-end.js" }] } ] } }
```

```js
// session-end.js（观察类，无需读 stdin）
require('fs').appendFileSync('/tmp/sema_session_end.log', new Date().toISOString() + '\n');
```

正常关闭会话时触发。对模型调用零影响（会话已结束），仅产生文件副作用；fire-and-forget，宿主进程随即退出时可能截断（best-effort）。

## 查询与事件

- `getHooksInfo(refresh?)`：返回合并后的配置视图（两份配置的路径/存在性、解析错误、按事件分组的条目及其状态与文件定位）；`refresh=true` 重新加载。
- `hook:notice` 会话事件：hook 的 `systemMessage` 展示与告警通道（超时、配置问题、输入被拦截），见[事件类型](wiki/core-concepts/event-system/event-catalog)。

## 注意事项

- 埋点整体 fail-open：hook 脚本报错、超时不影响主流程（除非配置 `failClosed`）；未配置 hooks 时零开销。
- `PreToolUse` 的 `deny` 独立于权限档位，Bypass 下仍生效；`allow` 会跳过权限询问，等于把权限决策交给脚本，执行有审计日志。
- 同一事件多个条目顺序执行，第一个阻断即停止后续条目。

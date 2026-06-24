# 权限系统概述

权限系统确保 AI 在执行可能影响系统状态的操作前获得用户授权，它横切整个运行时。

## 权限类型

| 类型 | 跳过开关（CoreConfig） | 默认行为 | 持久化格式 |
|------|---------|---------|-----------|
| 文件编辑 | `skipFileEditPermission` | 需要确认 | 会话级授权（不写入 allowedTools） |
| 终端执行 `run_shell` | `skipShellExecPermission` | 需要确认 | `'run_shell(前缀:*)'` 或 `'run_shell(完整命令)'` |
| Skill 调用 | `skipSkillPermission` | 需要确认 | `'Skill(name)'` |
| MCP 工具 | `skipMCPToolPermission` | 需要确认 | `'mcp__server_tool'`（工具名本身） |
| Fetch Url | `skipFetchUrlPermission` | 需要确认 | `'fetch_url(domain)'` |
| 项目外文件读取 `view_file` | `skipExternalFileReadPermission` | 项目内/临时文件静默放行，项目外需要确认 | 会话级授权（按父目录，不写入 allowedTools） |

> 对应跳过开关为 `true` 时，该类工具直接放行，不再进入任何检查。其余工具（非以上类型）默认放行。各工具的具体判定流程见[工具权限检查](shell-check)。

## 权限自由度档位（会话级）

每个 `SemaSession` 持有一个权限自由度档位，控制「需要确认的动作」被自动放行的力度。档位由 `createSession({ permissionLevel })` 指定初始值（默认 `'Ask'`），运行中通过 `session.updatePermissionLevel(level)` 调整，变更时触发 `permissionLevel:update` 事件。

| 档位 | 自由度 | 行为 |
|------|--------|------|
| `'Ask'` | 最低 | 每个需要确认的动作都弹窗询问 |
| `'AutoEdit'` | 中 | 项目目录内（含系统临时目录）的文件编辑自动放行，其余动作仍询问 |
| `'AutoRun'` | 最高 | 在发出人工权限申请前先做自动安全判断，判定安全则放行，否则转人工 |

> 档位只能由用户显式提升，或在文件编辑弹窗选择 `'allow'` 时由 `grantGlobalEditPermission()` 从 `'Ask'` 提升到 `'AutoEdit'`；已是 `'AutoEdit'` / `'AutoRun'` 时不会被自动降级。关闭/新建会话不继承该档位。

### AutoRun 自动安全判断

`AutoRun` 档位下，动作在转人工之前先经过一道自动判断，按工具类型分流：

- **文件编辑**：确定性判断，不走模型。项目目录内 / 系统临时目录放行，其余项目外转人工。
- **Skill**：放行（仅注入提示词；技能内的真实动作会作为下游工具再次过权限闸门）。
- **MCP 工具**：转人工（外部不可逆副作用，语义对模型不透明）。
- **fetch_url**：先做确定性 SSRF 兜底——命中环回（`127.0.0.0/8`、`::1`）、链路本地（`169.254.0.0/16`，含云元数据 `169.254.169.254`）、内网（`10/8`、`172.16/12`、`192.168/16`、`100.64/10`、IPv6 ULA/链路本地）、`localhost`、`metadata.google.internal` 等一律转人工，不交给模型；未命中再交由快速模型判断。
- **run_shell 及其余动作**：交给快速模型（`quick` 指针）判断 `safe` / `risky`。仅当模型明确返回单词 `safe` 时放行；其余情况（解释性文本、空响应、API 错误、超时、中断）一律失败关闭（fail-closed），转人工。

> 安全判断以**当前执行代理自身**的会话历史作为上下文旁路调用模型，绝不写回会话历史——子代理用子代理自己的上下文，而非主代理。
>
> `run_shell` 的 AutoRun 判断在其专属检查流程中提前完成，详见[工具权限检查](shell-check)。

经模型判定 `safe` 自动放行时不弹窗，但会发一个单向的 `tool:permission:auto` 事件供 UI 提示「已自动放行」；档位变更则发 `permissionLevel:update`。两者均无需回应，结构见[事件目录](../event-system/event-catalog)。

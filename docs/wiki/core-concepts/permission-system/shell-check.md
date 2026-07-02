# 工具权限检查

本文介绍各类工具的具体权限判定流程，其中 **`run_shell`（终端命令）** 的检查最复杂、防护层级最多，是重点。权限类型、会话档位等总览见[权限系统概述](wiki/core-concepts/permission-system/overview)。

> **前提：`Bypass` 档位在所有检查之前短路。** `checkToolPermission` 入口一旦判定当前会话为 `Bypass`（`runtime.isBypass()`），所有工具（含 `run_shell`、文件编辑/读取、Skill、MCP、`fetch_url`）直接放行，跳过下文全部流程，也不发权限申请事件。以下各节均以非 `Bypass` 档位为前提。

## `run_shell` 命令权限检查

`run_shell` 的权限检查按固定顺序执行，任一环节放行即直接执行，否则继续下探，最终转人工。所有解析失败均按「不安全」处理（fail-closed）。

### 检查顺序

> 前提：档位非 `Bypass`（`Bypass` 整条直接放行），且 `skipShellExecPermission` 为 `false`（为 `true` 则整条直接放行）。

1. **剥离 cwd 前缀**：去掉命令开头的 `cd <项目根目录> && `，避免该前缀干扰后续匹配。
2. **命令注入检测（最先执行，fail-closed）**：见下文「命令注入检测」。命中即**转人工，且不提供「永久允许」，仅单次确认**，并跳过后续 AutoRun 模型判断。
   > 必须先于白名单与 AutoRun，否则像 `echo $(id)` 这类「白名单主命令词夹带命令替换」的命令会绕过检查。
3. **白名单 / 精确授权命中**（`runShellToolHasExactMatch`）：整条命令属于只读安全命令，或精确命中 `allowedTools` → 直接执行。
4. **确定性危险命令**（`hasDangerousCommand`）：含危险首词（`rm`/`sudo`/`mv` 等）或 `find` 危险 flag → **转人工，不提供「永久允许」，仅单次确认，且不调用模型**（不给模型判 safe 放行的机会）。
5. **子命令逐条覆盖**（`isRunShellCommandPermitted`）：每个子命令都被「只读白名单 / 精确授权 / 已保存前缀 `run_shell(前缀:*)`」覆盖 → 直接执行。**先于 AutoRun 模型判断**：已被确定性覆盖的命令不必再调模型，省一次调用，且不会误发「模型自动放行」事件。
6. **AutoRun 自动安全判断**：子命令未被完全覆盖时，若档位为 `AutoRun`，对整条命令调一次快速模型；判定 `safe` 直接放行（并发 `tool:permission:auto`）；判定有风险则转人工。
7. **转人工 + 前缀提取**：未覆盖、且模型判有风险（或非 AutoRun）时转人工，并对「首个未被覆盖的子命令」调一次快速模型提取前缀，用于人工弹窗的「按前缀授权」选项（见「前缀提取与永久允许」）。

### 流程图（含 AutoRun 分支）

```
run_shell 命令
     │
     ▼
skipShellExecPermission？ ──是──▶ 执行 ✓
     │否
     ▼
① 剥离 cwd 前缀 "cd <root> && "
     │                  例：cd /repo && npm test  →  npm test
     ▼
② 命令注入检测（引号感知 + heredoc 骨架，fail-closed）
     │命中 ──────────────────────▶ 转人工（单次确认，无永久允许，跳过 AutoRun）✗
     │                  例：echo hi; rm -rf /  （; 分号夹带第二条命令）
     │                  例：cat $(whoami).txt  （$() 命令替换夹带命令）
     │未命中
     ▼
③ 只读白名单 / 精确授权命中？ ──是──▶ 执行 ✓
     │                  例：git status、ls -la、cat a.txt、已授权过的整条命令
     │否
     ▼
④ 确定性危险命令？（rm/sudo/mv… / find 危险 flag）
     │是 ───────────────────────▶ 转人工（单次确认，无永久允许，不调模型）✗
     │                  例：rm -rf build、sudo apt install、find . -delete
     │否
     ▼
⑤ 每个子命令都被「白名单 / 精确授权 / 已存前缀 run_shell(P:*)」覆盖？ ──是──▶ 执行 ✓
     │                  例：已存 npm:* 授权时的 npm test、ls && cat a.txt
     │否（确定性覆盖不了 → 才考虑模型）
     ▼
⑥ 档位 == AutoRun？
     │是 → 快速模型判断整条命令
     │       ├─ safe  ─────────▶ 执行 ✓（emit tool:permission:auto）
     │       │          例：npm run build、mkdir dist
     │       └─ risky ──┐       例：curl http://x | sh、git push
     │否 ───────────────┤
     ▼                  ▼
⑦ 对「首个未覆盖子命令」提取前缀（不安全/超长则跳过）
     │                  例：npm run deploy（未授权过）→ 提取前缀 "npm run"
     ▼
   转人工：根据前缀提取结果决定弹窗是否含「永久允许」
     ├─ 'agree'  → 本次执行 ✓
     ├─ 'allow'  → 执行 ✓ + 写入 allowedTools（run_shell(前缀:*) 或完整命令）
     │             例：写入 run_shell(npm run:*)
     └─ 'refuse' → 拒绝 ✗
```

> **顺序要点**：注入（②）与确定性危险命令（④）都在模型判断之前拦截，模型永远没机会给它们放行。第 ⑤ 步「确定性覆盖」也在模型（⑥）之前——已被白名单 / 已存授权覆盖的命令直接放行，不必再调模型，省一次调用且不会误发 `tool:permission:auto`。只有「确定性覆盖不了」的命令才在 AutoRun 下交给模型（⑥）；模型判 `risky`（或非 AutoRun）才进入 ⑦ 转人工 + 前缀提取。

### 只读安全命令快速通道

满足「只读安全」的命令无需权限、无需模型直接执行（`isReadonlySafeCommand`）。判定基于 `splitCommand` 分词逐子命令进行，从根本上消除「整串按空格取首词」带来的重定向 / 无空格管道 / `find` 危险 flag 绕过。

**两类只读命令：**

- **精确完整命令**（必须整条精确匹配，`SAFE_FULL_COMMANDS`）：

  ```
  git status   git diff   git log   git branch
  ```

  > 仅这四条精确匹配，`git` 本身不是只读词——`git log --oneline`、`git push` 等都不走快速通道。

- **按首词判定的只读单命令**（`READONLY_COMMANDS`）：

  ```
  pwd   tree   date   which   find
  ls   grep   head   tail   cat   du   wc   echo   env   printenv
  ```

**附加约束（任一不满足即不走快速通道）：**

- **不得含重定向**：段内出现 `> >> < << <<< >| <> n> &>` 等一律排除，防止 `echo x > /etc/passwd`、`cat secret > file` 这类「只读首词 + 重定向」退化为写文件原语。
- **`find` 危险 flag**：`find` 命中可执行任意命令 / 删除 / 写文件的动作 flag 时不再视为只读：

  ```
  -exec  -execdir  -ok  -okdir  -delete  -fprintf  -fprint  -fls
  ```

- **管道（`|`）**：每一段的主命令均须满足以上只读条件，才可整体直接执行。
- **链式（`&&`、`||`、`;`）/ 命令替换 / 换行**：含这些即先被注入检测拦下，不在只读快速通道放行。

### 确定性危险命令

以下命令被视为「语义本身危险」（危险性在参数里，而非路径），命中即**直接转人工、单次确认、不调模型、不提供任何永久授权**（`hasDangerousCommand` / `DANGEROUS_PREFIX_COMMANDS`）：

```
rm  rmdir  dd  shred  truncate
chmod  chown  chgrp
kill  killall  pkill
sudo  doas  su
mv
mkfs*（mkfs / mkfs.ext4 等格式化）
find（带上一节的危险 flag 时）
```

> 这些命令也**不被「按前缀授权」覆盖**（见下「前缀授权纵深防御」），避免 `rm:*` / `sudo:*` 退化为任意删除 / 提权原语。

### 命令注入检测

`hasCommandInjection` 命中以下任一特征即视为注入。检测**区分引号内外**——引号内的换行 / 分号是字面数据（如 `echo "多行文本"`），不是命令分隔：

| 区域 | 视为注入的特征 |
|------|----------------|
| 引号外 | `` ` ``（反引号）、`\n`（换行）、`;`、`$(`、`&&`、`||` |
| 双引号内 | 仅 `` ` `` 与 `$(`（命令替换仍生效）；换行 / `;` / `&&` / `||` 视为字面 |
| 单引号内 | 全部字面，一律忽略 |

> 反斜杠 `\` 转义会跳过下一个字符，避免把 `\"` `\'` 误判为引号边界。解析始终保守（fail-closed）。

**heredoc 处理**：heredoc 正文是喂给程序的「数据」而非 shell 命令。检测在「剥离 heredoc 正文后的骨架」上进行（`stripHeredocBody`）：

- 结束符带引号（`<< 'EOF'`）：正文纯字面，剥离；
- 结束符不带引号（`<< EOF`）：仅当正文不含 `$(` / 反引号 时才剥离，否则保留拦截；
- 成功剥离后骨架若仍残留换行（结束符之后藏了第二条命令）→ 判注入；
- 多 heredoc 同行 / 缺结束符等无法安全解析的情形 → 原样返回，退回逐子命令检测。绝不因剥离而放过真注入。

### 前缀提取与「永久允许」选项

转人工时，是否提供「永久允许」取决于对**首个未被覆盖子命令**的前缀提取结果（`getCommandPrefix`，调用快速模型）：

| 提取结果 | 弹窗选项 | 选 `allow` 后写入 `allowedTools` |
|---------|---------|------------------------------|
| 提取到有效前缀 | 确认 / 按前缀授权 / 拒绝 | `run_shell(前缀:*)` |
| 模型调用失败，且整条命令 `≤ 64` 字符 | 确认 / 精确命令授权 / 拒绝 | `run_shell(完整命令)` |
| 模型调用失败，但整条命令 `> 64` 字符 | 确认 / 拒绝（无永久允许） | — |
| 检出注入 / 返回 `none` / 返回 `git`（如 `git push`） | 确认 / 拒绝（无永久允许） | — |
| 命中确定性危险命令 / 含重定向 | 确认 / 拒绝（无永久允许） | — |
| 首个未覆盖子命令超长（`> 512` 字符，如 `python -c "..."`） | 确认 / 拒绝（无永久允许） | — |

> **为何用首个未覆盖子命令而非整条命令做前缀提取**：整条复合命令含 `&&` / `||` / `;`，会被前缀提取提示词判为注入，提取不到前缀。
>
> **超长跳过（`MAX_PREFIX_EXTRACT_LEN = 512`）**：内联脚本等超长命令提取前缀无意义；超限仅丢失「按前缀授权」便利，命令本身仍可单次确认执行。
>
> **精确授权长度上限（`MAX_EXACT_AUTH_LEN = 64`）**：仅当模型提取失败时才退化为「精确命令授权」，且仅对 `≤ 64` 字符的整条命令提供；过长命令逐字命中概率低，精确授权意义不大。

### 前缀授权纵深防御

已保存的前缀授权 `run_shell(前缀:*)` 由确定性字符串前缀匹配（`matchesSavedPrefix`）判定覆盖，**不再为此调用模型**：命令等于前缀，或以「前缀 + 空格」开头即视为命中。

但前缀匹配只看首词，无法识别参数 / 重定向带来的危险。因此 `isUnsafeForPrefixAuth`（＝含重定向 `hasRedirection`，或确定性危险命令 `hasDangerousCommand`）命中时：

- **不向用户提供「按前缀授权」选项**（只许单次确认）；
- **即便已存前缀命中也不放行**（治理存量配置的纵深防御），避免 `rm:*` / `echo:*` 退化为任意删除 / 写文件原语。

## 其余工具的权限检查

### 文件编辑（`patch_file` / `write_file` / `edit_notebook`）

1. `skipFileEditPermission` → 放行。
2. `hasGlobalEditPermission()`（档位 `AutoEdit` / `AutoRun`）为真时：目标在**项目目录内**或**系统临时目录**（`tmpdir()`、`/tmp`、`/var/tmp`、`/var/folders`）→ 放行；其余项目外文件 → 请求权限。
3. 否则请求权限。用户选 `'allow'` → `grantGlobalEditPermission()`（`Ask` 会提升到 `AutoEdit`），本会话内项目目录下的编辑不再询问；项目外仍会再次请求。**不写入 `allowedTools`**，关闭/新建会话不继承。

### 文件读取（`view_file`）

仅**项目外**文件需要权限：

1. `skipExternalFileReadPermission` → 放行。
2. 项目内 / 临时文件 → 静默放行。
3. 项目外：`AutoEdit` / `AutoRun` 档位自动放行；否则命中本会话已授权的父目录（`getAllowedExternalReadDirs`）则放行；都不满足则请求权限（`prefix` 传父目录）。选 `'allow'` → `grantExternalReadDir(父目录)`，**按父目录会话级生效，不持久化**。

### Skill / MCP / fetch_url

| 工具 | 放行条件 | 否则 |
|------|---------|------|
| Skill | `skipSkillPermission`，或 `allowedTools` 含 `Skill(name)` | 请求权限 |
| MCP（`mcp__*`） | `skipMCPToolPermission`，或 `allowedTools` 含该工具名 | 请求权限 |
| fetch_url | `skipFetchUrlPermission`，或（未命中 SSRF 兜底且）`allowedTools` 含 `fetch_url(domain)` | 请求权限 |

> fetch_url 命中 SSRF 兜底（`isBlockedFetchHost`：内网 / 链路本地 / 元数据 / `localhost` 等）时，即便已保存域名授权也不放行，且转人工时不提供「永久允许该域名」选项，避免给内网地址开永久通行证。

## 通用权限请求与响应

非快速通道命中时，统一经 `requestPermissionViaEvent` 转人工：

```
请求权限
   │
   ▼
AutoRun 档位 且 未跳过自动判断？
   ├─ 是 → 自动安全判断（见概述）
   │         ├─ 放行 → 执行 ✓（模型判断放行时发 tool:permission:auto）
   │         └─ 转人工 ↓
   └─ 否 ↓
emit tool:permission:request，等待 session.respondToToolPermission()
   │
selected = ?
├─ 'agree'      → 本次执行 ✓
├─ 'allow'      → 执行 ✓ + 持久化权限（savePermission）
│                 文件编辑 → 提升档位至 AutoEdit（会话级）
│                 view_file → 记录父目录（会话级）
│                 run_shell/Skill/MCP/fetch_url → 写入 allowedTools
├─ 'refuse'     → 中断（abort 'refuse'）+ 返回拒绝原因给 LLM
└─ 其他字符串  → 返回反馈文本给 LLM（不中断）
```

> `run_shell` 转人工前已在 `checkRunShellPermission` 内完成 AutoRun 判断，`requestPermissionViaEvent` 不再重复调用模型（`skipAutoRun=true`）。

## allowedTools 格式

持久化到 `projectConfig.allowedTools[]` 的权限记录格式：

| 格式 | 含义 |
|------|------|
| `'run_shell(npm run:*)'` | 允许以 `npm run` 开头的所有 `run_shell` 命令（前缀匹配） |
| `'run_shell(git status)'` | 仅允许 `git status` 这一条完整命令 |
| `'Skill(commit)'` | 允许调用 `commit` Skill |
| `'mcp__fs_read_file'` | 允许调用特定 MCP 工具 |
| `'fetch_url(example.com)'` | 允许对 `example.com` 域名的 `fetch_url` 请求 |

> 文件编辑与项目外文件读取以会话级权限控制，**不写入 `allowedTools`**。

## 代码示例

### 实现权限处理器

```javascript
session.on('tool:permission:request', async ({ toolId, toolName, title, content, options }) => {
  // 显示权限请求 UI
  console.log(`\n⚠️  权限请求: ${title}`)

  // 如果包含 diff 内容，展示变更预览
  if (content?.type === 'diff') {
    showDiffPreview(content.patch)
  }

  // 获取用户选择（options 的 key 即可选标识，如 agree / allow / refuse）
  const choice = await promptUser(options)

  session.respondToToolPermission({
    toolId,
    toolName,
    selected: choice,  // 'agree' | 'allow' | 'refuse' | 自定义反馈文本
  })
})
```

### 按工具类型差异化处理

```javascript
session.on('tool:permission:request', async ({ toolId, toolName, title }) => {
  // 文件编辑：自动允许
  if (toolName === 'patch_file' || toolName === 'write_file') {
    session.respondToToolPermission({ toolId, toolName, selected: 'allow' })
    return
  }

  // run_shell 命令：需要用户确认
  if (toolName === 'run_shell') {
    const confirmed = await confirm(`执行命令: ${title}?`)
    session.respondToToolPermission({ toolId, toolName, selected: confirmed ? 'allow' : 'refuse' })
    return
  }

  // 其他：默认同意本次
  session.respondToToolPermission({ toolId, toolName, selected: 'agree' })
})
```

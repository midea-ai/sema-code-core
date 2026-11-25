# 数据持久化

Sema Core 的所有持久化数据存储在用户主目录的 `~/.sema/` 下，以及项目根目录的 `.sema/` 下。

## 目录结构

### 用户主目录 `~/.sema/`

```
~/.sema/                          # 全局配置目录
├── model.conf                    # 模型配置
├── projects.conf                 # 项目配置（按工作目录分组）
├── settings.json                 # 用户级设置（env 等）
├── .mcp.json                     # 全局 MCP 服务器配置
├── AGENTS.md                     # 全局 Agent 提示词/规则配置
├── history/                      # 会话历史
│   └── -Users-dev-my-project/    # 项目目录（路径分隔符替换为 -）
│       ├── 2026-11-25_[sessionId].jsonl
│       ├── 2026-11-25_[sessionId].meta.json
│       ├── 2026-11-25_[sessionId]/   # 按需创建，内部为 [agentId].jsonl
│       └── [sessionId].attachments  # 该会话登记的附件清单
├── attachments/                  # 附件（粘贴文本、附图原图、生成图等）
│   └── [uuid]/                   # 每次写入一个目录
├── logs/                         # 服务运行日志
│   └── 2024-01-15.log
├── llm_logs/                     # LLM 请求/响应原始日志
│   └── 2024-01-15_[sessionId].log
├── tracks/                       # LLM 日志归档（提取最长对话）
│   └── 2024-01-15.log
├── event/                        # 事件日志
│   └── 2024-01-15_[sessionId].log
├── stats/                        # 使用统计（每个产品一个子目录，按天一文件）
│   └── [product]/
│       └── 2024-01-15.jsonl
├── cache/                        # 缓存
│   └── shell-[envHash].json      # Windows shell 探测结果（跨进程复用）
├── skills/
│   └── [skill-name]/
│       └── SKILL.md              # 用户级 Skill
├── agents/
│   └── [agent-name].md           # 用户级 Agent 配置
└── plugins/
    ├── known_marketplaces.json   # 已知市场列表
    ├── installed_plugins.json    # 已安装插件列表
    ├── marketplaces/             # 市场源缓存
    └── cache/                    # 插件下载缓存
```

### 项目根目录 `.sema/`

```
.sema/                            # 项目配置目录（项目根目录下）
├── .mcp.json                     # 项目级 MCP 服务器配置
├── settings.json                 # 项目设置（env/MCP 禁用/工具白名单等）
├── skills/
│   └── [skill-name]/
│       └── SKILL.md              # 项目级 Skill（优先于用户级）
├── agents/
│   └── [agent-name].md           # 项目级 Agent（优先于用户级）
├── memory/
│   ├── MEMORY.md                 # 记忆索引
│   └── [topic].md                # 主题记忆文件
└── plans/                        # 计划文件
    └── [plan-name].md
```


## 各文件详解

### 项目配置 `~/.sema/projects.conf`

存储项目配置，按工作目录路径分组：

```json
{
  "/Users/dev/project-a": {
    "allowedTools": ["patch_file", "run_shell(git status)", "run_shell(npm run test)"],
    "history": ["帮我优化代码", "分析这个函数", "运行测试"],
    "lastEditTime": "2024-01-15T10:30:00.000Z",
    "rules": ["使用中文回复", "修改前先阅读文件"]
  },
  "/Users/dev/project-b": {
    "allowedTools": [],
    "history": [],
    "lastEditTime": "2024-01-10T08:00:00.000Z",
    "rules": []
  }
}
```

每个项目配置包含：
- `allowedTools`：允许使用的工具列表
- `history`：用户输入历史（倒序，最新的在前）
- `lastEditTime`：最后编辑时间
- `rules`：项目级规则

**自动清理**：
- 每个项目最多保留 **30 条**输入历史（`PROJECT_HISTORY_LENGTH_LIMIT`）
- 全局最多保留 **20 个**项目，超过时删除 `lastEditTime` 最旧的（`PROJECT_LENGTH_LIMIT`）

### 模型配置 `~/.sema/model.conf`

存储所有已配置的模型和指针：

```json
{
  "modelProfiles": [
    {
      "name": "deepseek-v4-flash[deepseek]",
      "provider": "deepseek",
      "modelName": "deepseek-v4-flash",
      "baseURL": "https://api.deepseek.com/anthropic",
      "apiKey": "sk-",
      "maxTokens": 16000,
      "contextLength": 256000,
      "adapt": "anthropic"
    },
    {
      "name": "deepseek-v4-pro[deepseek]",
      "provider": "deepseek",
      "modelName": "deepseek-v4-pro",
      "baseURL": "https://api.deepseek.com/anthropic",
      "apiKey": "sk-",
      "maxTokens": 32000,
      "contextLength": 256000,
      "adapt": "anthropic"
    }
  ],
  "modelPointers": {
    "main": "deepseek-v4-pro[deepseek]",
    "quick": "deepseek-v4-flash[deepseek]"
  }
}
```

### MCP 配置 `~/.sema/.mcp.json` 和 `.sema/.mcp.json`

MCP 服务器配置（全局和项目级格式相同），支持 `.mcp.json` 和 `mcp.json` 两种文件名，支持 `mcpServers` 包裹格式或直接对象格式：

```json
{
  "mcpServers": {
    "filesystem": {
      "name": "filesystem",
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "enabled": true,
      "useTools": null
    }
  }
}
```

MCP 加载优先级：**插件 MCP < 用户级 < 项目级**，项目级配置可以覆盖用户级同名服务。

### 设置文件 `~/.sema/settings.json` 和 `.sema/settings.json`

设置文件分用户级（`~/.sema/settings.json`）和项目级（`.sema/settings.json`）两层：

```json
{
  "env": {
    "HTTP_PROXY": "http://127.0.0.1:7890"
  },
  "disabledMcpServers": ["filesystem"],
  "enabledMcpServerUseTools": {
    "context7": ["resolve-library-id", "query-docs"]
  },
  "disabledHooks": ["a9546d121132"]
}
```

- `env`：注入到终端执行、后台任务、hooks 子进程的环境变量，并参与 `.mcp.json` 的 `${VAR}` 展开，合并顺序为 **进程环境 < 用户级 env < 项目级 env**（后者覆盖前者），修改后重启服务生效
- `disabledMcpServers`：已禁用的 MCP 服务名列表（仅项目级）
- `enabledMcpServerUseTools`：按服务名指定的可用工具白名单（仅项目级）
- `disabledHooks`：已禁用的 hook 条目 id 列表（用户级与项目级取并集），由 `disableHook` / `enableHook` 写入，id 见 `getHooksInfo` 的条目

### 会话历史 `~/.sema/history/[project-dir]/`

主会话用一份 JSONL 保存有效消息，用同名 `.meta.json` 保存状态和提交边界。例如用户连续追问十轮，普通保存只追加新消息；用户回退或压缩后，JSONL 被替换为剩下的有效历史。项目目录名由工作目录路径转换而来，如 `/Users/dev/my-project` 对应 `-Users-dev-my-project`。

```text
history/-Users-dev-my-project/
├── 2026-11-25_a1b2c3d4.jsonl
├── 2026-11-25_a1b2c3d4.meta.json
├── 2026-11-25_a1b2c3d4/                 # 有子代理消息才创建
│   └── V1StGXR8_Z5jdHi6B-myT.jsonl     # 实际 agentId，也就是任务 ID
├── a1b2c3d4.attachments                # 附件登记清单
├── dailybot.jsonl                     # 固定会话不带日期
└── dailybot.meta.json
```

消息文件每行保存一条完整 Message，保留图片、工具结果、usage 和消息自带的扩展字段；不会为 hooks 再写一份 transcript。以下两行演示正文内换行如何转义：

```jsonl
{"type":"user","uuid":"u1","checkpointSeq":0,"message":{"role":"user","content":"介绍自己"}}
{"type":"user","uuid":"u2","checkpointSeq":0,"message":{"role":"user","content":"用中文回答\n列出主要能力"}}
```

同名 meta 的结构如下；`committedBytes` 是实际 JSONL 前缀的 UTF-8 字节数，示例中的数值需按消息文件计算：

```json
{
  "version": 2,
  "sessionId": "a1b2c3d4",
  "revision": 2,
  "historyEpoch": 1,
  "committedBytes": 256,
  "messageCount": 2,
  "lastMessageUuid": "u2",
  "updatedAt": 1795564800000,
  "todos": [],
  "todoTasks": [],
  "readFileTimestamps": {},
  "goal": null
}
```

| 数据 | 保存时机 | 替换与恢复规则 |
| --- | --- | --- |
| 主消息 | 新输入、轮末、关闭及需要读取历史的 hook 前 | 常规仅追加新增消息；修改已有消息时重写，包含微压缩、摘要、回退、清空和输入撤销 |
| 元信息 | 消息提交或状态变化 | 原子替换；`revision` 每次提交递增，`historyEpoch` 仅在历史重写时递增 |
| 子代理消息 | 启动、轮末、结束与关闭 | 使用实际 agentId，不依赖 hooks 开关；只供查看和脚本读取，不恢复任务执行 |
| 旧版 JSON | 兼容加载，首次保存时迁移 | 以旧 JSON 为准替换同名旧 transcript，成功后删除旧 JSON |

`goal` 保存长期目标，无目标时为 `null`。重开会话时运行中的目标降为暂停，不自动接续；回退时从剩余用户消息的目标标记推导目标状态。分支创建新的主文件组，并复制附件登记和所需快照，不复制子代理文件。

**提交与读取**：先追加并同步消息，再原子替换 meta；恢复时只接受 `committedBytes` 内的完整记录，超出的尾部不算已提交。重写通过 `.txn-<id>.*.tmp` 暂存文件与 `.rewrite.json` 安装清单恢复，成功后清理临时文件；已提交区损坏会报错，不作为空会话覆盖。同一会话的第二个进程写入者会收到 `HISTORY_BUSY`。

**加密**：启用后主、子消息每行独立加密，meta 和事务清单整体加密，文件名均追加 `.enc`。`committedBytes` 按密文字节计算，读取者须先截取有效前缀再逐行解密。

**自动清理**：按逻辑会话计数，每项目最多保留 50 个参与淘汰的带日期会话，全局最多保留 100 个项目，每小时最多触发一次。固定无日期会话不参与数量淘汰；活动写入者、正在读取的 hooks 和未恢复事务会被保留。删除会话时一起删除主文件组、子目录及旧 transcript，历史删除成功后才释放附件和无主快照。

### 附件 `~/.sema/attachments/[uuid]/`

附件目录存放不属于项目文件的会话产物，每次写入新建一个 `[uuid]` 子目录：

- 宿主转存的超长粘贴文本
- 用户附图的原图（发给模型的是压缩后的副本）；路径随 `input:processing` 事件带给宿主，宿主的会话存档只需记路径，不必再存一份图片
- 文生图工具生成的图片（未指定保存位置时）
- 写文件工具写进该目录的文件（如可视化页面）

目录本身不带归属。归属记在会话历史目录下的清单文件 `[sessionId].attachments` 里，每行一个附件目录名，只追加。附件经过 core 时登记到当前会话名下：

- 附图原图、生成图落盘
- 写文件工具写入附件目录
- 用户消息用 `@` 引用了附件目录下的文件

分支出新会话时清单一并复制，同一个附件可以登记在多个会话名下。

**自动清理**：
- 跟随会话：会话历史被删除或淘汰、项目历史目录被删除、执行 `/clear` 时，该会话登记的附件里没有被其他会话登记的一起删除，清单随之删除
- 期限兜底：未登记的附件，最后修改超过 **30 天**（`ATTACHMENTS_RETAIN_MS`）且排在最新 **100 个**（`ATTACHMENTS_RETAIN_COUNT`）之外时删除；已登记的不受此规则影响
- 体积上限：附件目录总体积超过 **2 GB**（`ATTACHMENTS_MAX_BYTES`）时从最旧的删起，先删未登记的
- 没有对应会话历史的清单超过 **24 小时**（`ATTACHMENT_LEDGER_ORPHAN_TTL`）后删除，其中的附件按未登记处理
- 期限兜底与体积上限随历史清理触发，每 **1 小时**最多一次

### 系统日志 `~/.sema/logs/[YYYY-MM-DD].log`

服务运行日志，按天分割，记录 debug/info/warn/error 级别消息。格式：

```
[HH:MM:SS] [INFO]: 消息内容
[HH:MM:SS] [WARN] [file.ts:line]: 消息内容
```

info 级不带调用位置（取调用栈较贵），warn / error 级带 `[file.ts:line]`。

**自动清理**：最多保留最近 **7 个**日志文件（`SERVICE_LOG_FILES_RETAIN_COUNT`）。

### LLM日志 `~/.sema/llm_logs/[YYYY-MM-DD]_[sessionId].log`

LLM 请求和响应的原始日志，按会话分文件存储。格式：

```
[HH:MM:SS]{请求或响应的 JSON}
```

**缺省不写**：每条请求都要把整份历史序列化落盘，代价大；调试时在构造配置里显式传 `disableLLMLog: false` 打开（也支持运行期 `updateCoreConfig` 打开）。关闭时连目录都不建。

**自动清理**：最多保留最近 **10 个**日志文件（`LLM_LOG_FILES_RETAIN_COUNT`），超出的文件在删除前会被归档到 `tracks/`。

### LLM 日志归档 `~/.sema/tracks/[YYYY-MM-DD].log`

LLM 日志归档文件，从原始日志中提取 **messages 最长的一次请求及其后续响应**，过滤掉 system 消息后追加存储。格式：

```
[HH:MM:SS][project-name]{model 和 messages 字段}
[HH:MM:SS]{响应内容}
```

**自动清理**：最多保留最近 **30 个**归档文件（`TRACKS_FILES_RETAIN_COUNT`）。

### 事件日志 `~/.sema/event/[YYYY-MM-DD]_[sessionId].log`

事件日志，记录系统内部事件流。格式：

```
[HH:MM:SS]eventName|{"key":"value"}
```

**自动清理**：最多保留最近 **10 个**日志文件（`EVENT_LOG_FILES_RETAIN_COUNT`）。

### 使用统计 `~/.sema/stats/<product>/[YYYY-MM-DD].jsonl`

由构造配置 `usageProduct` 开启采集（不传则不写）。每个产品一个子目录，`product` 须为字母数字 `._-` 组成的简单名字（不能以 `.` 开头），否则本进程不采集。每行一个 JSON 对象，只有计数与名称，不含对话内容：

```
{"t":1705300000000,"requests":12,"tokens":{"hit":80000,"miss":20000,"output":6000},"models":{"deepseek-v4-pro[deepseek]":{"requests":12,"hitKnown":true,"tokens":{...}}},"tools":{"view_file":{"calls":9,"errors":0}},"skills":{"commit":{"calls":1,"lastAt":1705300000000}},"sessions":["<sessionId>"]}
```

- `t`：落盘时间；产品由所在目录决定，行内不存
- 采集在内存累加，账本非空后 **10 秒**（`USAGE_STATS_FLUSH_INTERVAL`）追加一行；`dispose()` 时同步落盘
- 多进程可并发追加同一文件；启动时把早于今天且多于一行的文件合并成一行

通过 `SemaCore.getUsageStats({ product })` 读取（累计 + 近 366 天逐日，缺省汇总全部产品目录），`clearUsageStats(product)` 删除该产品目录（`product` 必填）。

### Shell 探测缓存 `~/.sema/cache/shell-[envHash].json`

仅 Windows。探测可用 shell（bash / wsl / PowerShell）要起子进程，首次动辄数秒，结果落盘后新进程直接复用，`SemaCore` 构造时也会提前在后台探测。文件名带 `PATH` / `SEMA_BASH` / `SHELL` 的哈希，桌面版、CLI、IDE 插件环境不同时各用各的条目，互不作废。

- **立即作废重探**：环境哈希变化、缓存的 bash 路径已不存在、出现了探测时没有的 bash 候选（如新装了 Git）
- **超过 24 小时**：先沿用旧结果，后台重探只刷新文件
- 写入走临时文件 + rename，临时文件名带 pid 和随机后缀，多线程跑 core 时不会互相覆盖

### 规则文件 `~/.sema/AGENTS.md` 和 `<project>/AGENTS.md`

Agent 规则/提示词文件，以 Markdown 格式存储。项目级文件（`<project>/AGENTS.md`）优先于用户级文件（`~/.sema/AGENTS.md`）。

## 优先级规则

当项目级和用户级存在同名配置时，项目级优先：

| 资源类型 | 用户级 | 项目级 | 优先级 |
|---------|--------|--------|--------|
| Skill | `~/.sema/skills/` | `.sema/skills/` | 项目级 > 用户级 |
| Agent | `~/.sema/agents/` | `.sema/agents/` | 项目级 > 用户级 |
| Rules | `~/.sema/AGENTS.md` | `<project>/AGENTS.md` | 项目级 > 用户级 |
| MCP 配置 | `~/.sema/.mcp.json` | `.sema/.mcp.json` | 项目级覆盖用户级同名服务 |

## 备份建议

- **API Keys**：`~/.sema/model.conf` 中包含 API Key，建议设置文件权限为 `600`
- **Skills 和 Agents**：建议纳入项目 Git 版本控制（`.sema/` 目录）
- **会话历史**：`~/.sema/history/` 可选择性备份，文件较大时可定期清理

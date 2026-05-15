# 数据持久化

Sema Core 的所有持久化数据存储在用户主目录的 `~/.sema/` 下，以及项目根目录的 `.sema/` 下。

## 目录结构

### 用户主目录 `~/.sema/`

```
~/.sema/                          # 全局配置目录
├── model.conf                    # 模型配置
├── projects.conf                 # 项目配置（按工作目录分组）
├── .mcp.json                     # 全局 MCP 服务器配置
├── AGENTS.md                     # 全局 Agent 提示词/规则配置
├── history/                      # 会话历史
│   └── -Users-dev-my-project/    # 项目目录（路径分隔符替换为 -）
│       ├── 2024-01-15_[sessionId-1].json
│       └── 2024-01-15_[sessionId-2].json
├── logs/                         # 服务运行日志
│   └── 2024-01-15.log
├── llm_logs/                     # LLM 请求/响应原始日志
│   └── 2024-01-15_[sessionId].log
├── tracks/                       # LLM 日志归档（提取最长对话）
│   └── 2024-01-15.log
├── event/                        # 事件日志
│   └── 2024-01-15_[sessionId].log
├── cache/                        # 缓存
│   └── llm-cache.json
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
├── settings.json                 # 项目设置（MCP 禁用/工具白名单等）
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

### 项目设置 `.sema/settings.json`

存储项目级 MCP 管理设置：

```json
{
  "disabledMcpServers": ["filesystem"],
  "enabledMcpServerUseTools": {
    "context7": ["resolve-library-id", "query-docs"]
  }
}
```

- `disabledMcpServers`：已禁用的 MCP 服务名列表
- `enabledMcpServerUseTools`：按服务名指定的可用工具白名单

### 会话历史`~/.sema/history/[project-dir]/[date]_[sessionId].json`

会话历史文件，按项目目录分组存储，由 `saveHistory()` 自动保存。项目目录名由工作目录路径转换而来（路径分隔符替换为 `-`，如 `/Users/dev/my-project` → `-Users-dev-my-project`）：

```json
{
  "messages": [
    {
      "type": "user",
      "message": {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "介绍自己"
          }
        ]
      },
      "uuid": "22141e63-95cf-40c1-95f2-eaaff7c6751c"
    },
    {
      "type": "assistant",
      "uuid": "336af515-e64b-4620-978f-72786d450485",
      "durationMs": 5717,
      "message": {
        "id": "ed584aae-a462-416b-8630-613ced0f8c1c",
        "type": "message",
        "role": "assistant",
        "model": "deepseek-chat",
        "content": [
          {
            "type": "text",
            "text": "我是 Sema，AIRC 的代码助手 AI。"
          }
        ],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": {
          "input_tokens": 0,
          "output_tokens": 140,
          "cache_creation_input_tokens": 0,
          "cache_read_input_tokens": 0
        }
      }
    }
  ],
  "todos": [],
  "todoTasks": [],
  "readFileTimestamps": {}
}
```

通过 `loadHistory(sessionId, projectPath)` 可恢复指定会话的历史。

**保存时自动去重 usage**：多个 assistant 消息只保留最后一条有实际 token 用量的消息的 usage 字段，其余消息剥离 usage 以节省空间。

**自动清理**：
- 每个项目目录最多保留 **50 个**历史文件（`PER_PROJECT_HISTORY_LENGTH_LIMIT`）
- 全局最多保留 **20 个**项目目录，超过时删除最久未活跃的（`PROJECT_LENGTH_LIMIT`）
- 清理每 **1 小时**最多触发一次（`HISTORY_CLEANUP_INTERVAL`）

### 系统日志 `~/.sema/logs/[YYYY-MM-DD].log`

服务运行日志，按天分割，记录 debug/info/warn/error 级别消息。格式：

```
[HH:MM:SS] [INFO] [file.ts:line]: 消息内容
```

**自动清理**：最多保留最近 **7 个**日志文件（`SERVICE_LOG_FILES_RETAIN_COUNT`）。

### LLM日志 `~/.sema/llm_logs/[YYYY-MM-DD]_[sessionId].log`

LLM 请求和响应的原始日志，按会话分文件存储。格式：

```
[HH:MM:SS]{请求或响应的 JSON}
```

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

### LLM 响应缓存 `~/.sema/cache/llm-cache.json`

LLM 响应缓存文件，由 `enableLLMCache` 配置控制是否启用。

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

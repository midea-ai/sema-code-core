# 数据持久化

Sema Code Core 的所有持久化数据存储在用户主目录的 `~/.sema/` 下，以及项目根目录的 `.sema/` 下。

## 目录结构

### 用户主目录 `~/.sema/`

```
~/.sema/                          # 全局配置目录
├── config.json                   # 核心配置 + 所有项目配置
├── models.json                   # 模型配置
├── mcp.json                      # 全局 MCP 服务器配置
├── AGENT.md                      # 全局 Agent 提示词配置
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
└── agents/
    └── [agent-name].md           # 用户级 Agent 配置
```

### 项目根目录 `.sema/`

```
.sema/                            # 项目配置目录（项目根目录下）
├── mcp.json                      # 项目级 MCP 服务器配置
├── skills/
│   └── [skill-name]/
│       └── SKILL.md              # 项目级 Skill（优先于用户级）
└── agents/
    └── [agent-name].md           # 项目级 Agent（优先于用户级）
```


## 各文件详解

### 项目配置 `~/.sema/config.json`

存储项目配置，按工作目录路径分组：

```json
{
  "/Users/dev/project-a": {
    "allowedTools": ["Edit", "Bash(git status)", "Bash(npm run test)"],
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

**自动清理**：
- 每个项目最多保留 **30 条**输入历史
- 全局最多保留 **20 个**项目，超过时删除 `lastEditTime` 最旧的

### 模型配置 `~/.sema/models.json`

存储所有已配置的模型和指针：

```json
{
  "modelProfiles": [
    {
      "name": "anthropic/claude-sonnet-4.5[openrouter]",
      "provider": "openrouter",
      "modelName": "anthropic/claude-sonnet-4.5",
      "baseURL": "https://openrouter.ai/api",
      "apiKey": "sk-or-v1-",
      "maxTokens": 8192,
      "contextLength": 128000,
      "adapt": "anthropic"
    },
    {
      "name": "anthropic/claude-haiku-4.5[openrouter]",
      "provider": "openrouter",
      "modelName": "anthropic/claude-haiku-4.5",
      "baseURL": "https://openrouter.ai/api",
      "apiKey": "sk-or-v1-",
      "maxTokens": 8192,
      "contextLength": 128000,
      "adapt": "anthropic"
    }
  ],
  "modelPointers": {
    "main": "anthropic/claude-sonnet-4.5[openrouter]",
    "quick": "anthropic/claude-haiku-4.5[openrouter]"
  }
}
```

### MCP 配置 `~/.sema/mcp.json` 和 `.sema/mcp.json`

MCP 服务器配置（全局和项目级格式相同）：

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

### 会话历史`~/.sema/history/[project-dir]/[date]_[sessionId].json`

会话历史文件，按项目目录分组存储，由 `StateManager.finalizeMessages()` 自动保存。项目目录名由工作目录路径转换而来（路径分隔符替换为 `-`，如 `/Users/dev/my-project` → `-Users-dev-my-project`）：

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
            "text": "我是 Sema，AIRC 的代码助手 AI。我专注于帮助用户完成软件工程任务，包括代码编写、调试、重构、解释代码、添加新功能等。\n\n我可以：\n- 读取、编辑和创建文件\n- 在代码库中搜索和查找代码\n- 运行命令和测试\n- 使用专门的工具进行代码探索和任务规划\n- 通过待办事项列表来管理和跟踪复杂任务\n\n我会保持专业客观，专注于技术准确性和问题解决，提供直接、客观的技术信息。对于安全相关任务，我只在授权测试、防御性安全、CTF 挑战和教育环境中提供帮助。\n\n请告诉我您需要什么帮助！"
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
  "todos": []
}
```

通过 `createSession(sessionId)` 可恢复指定会话的历史。

**自动清理**：
- 每个项目目录最多保留 **50 个**历史文件
- 全局最多保留 **20 个**项目目录，超过时删除最久未活跃的

### 系统日志 `~/.sema/logs/[YYYY-MM-DD].log`

服务运行日志，按天分割，记录 debug/info/warn/error 级别消息。格式：

```
[HH:MM:SS] [INFO] [file.ts:line]: 消息内容
```

**自动清理**：最多保留最近 **7 个**日志文件。

### LLM日志 `~/.sema/llm_logs/[YYYY-MM-DD]_[sessionId].log`

LLM 请求和响应的原始日志，按会话分文件存储。格式：

```
[HH:MM:SS]{请求或响应的 JSON}
```

**自动清理**：最多保留最近 **10 个**日志文件，超出的文件在删除前会被归档到 `tracks/`。

### LLM 日志归档 `~/.sema/tracks/[YYYY-MM-DD].log`

LLM 日志归档文件，从原始日志中提取 **messages 最长的一次请求及其后续响应**，过滤掉 system 消息后追加存储。格式：

```
[HH:MM:SS][project-name]{model 和 messages 字段}
[HH:MM:SS]{响应内容}
```

**自动清理**：最多保留最近 **30 个**归档文件。

### 事件日志 `~/.sema/event/[YYYY-MM-DD]_[sessionId].log`

事件日志，记录系统内部事件流。格式：

```
[HH:MM:SS]eventName|{"key":"value"}
```

**自动清理**：最多保留最近 **10 个**日志文件。

### LLM 响应缓存 `~/.sema/cache/llm-cache.json`

LLM 响应缓存文件。

## 优先级规则

当项目级和用户级存在同名配置时，项目级优先：

| 资源类型 | 用户级 | 项目级 | 优先级 |
|---------|--------|--------|--------|
| Skill | `~/.sema/skills/` | `.sema/skills/` | 项目级 > 用户级 |
| Agent | `~/.sema/agents/` | `.sema/agents/` | 项目级 > 用户级 |
| MCP 配置 | `~/.sema/mcp.json` | `.sema/mcp.json` | 各自独立（不覆盖） |

## 备份建议

- **API Keys**：`~/.sema/models.json` 中包含 API Key，建议设置文件权限为 `600`
- **Skills 和 Agents**：建议纳入项目 Git 版本控制（`.sema/` 目录）
- **会话历史**：`~/.sema/history/` 可选择性备份，文件较大时可定期清理

# SubAgent 使用

SubAgent 是在隔离上下文中运行的专用子代理。每个 SubAgent 拥有独立的消息历史和状态，专注于特定类型的任务（如代码探索、架构设计、测试等）。

## AgentConfig 接口

```typescript
interface AgentConfig {
  name: string              // Agent 唯一名称
  description: string       // 功能描述（AI 会据此选择合适的 Agent）
  prompt: string            // 系统提示词
  tools?: string[] | '*'    // 可用工具列表，'*' 表示所有工具，不填默认所有工具
  model?: string            // 'main'（主模型）或 'quick'（快速模型），默认 main
  locate?: 'user' | 'project' | 'builtin'  // 来源（只读）
}
```


## 存放位置与优先级

| 级别 | 路径 | 优先级 |
|------|------|--------|
| 项目级 | `.sema/agents/[name].md` | 高 |
| 用户级 | `~/.sema/agents/[name].md` | 中 |
| 内置 | 代码内置 | 低 |

同名 Agent：项目级 > 用户级 > 内置。


## Agent 文件格式

```markdown
---
name: database-expert
description: 专精数据库设计与优化的代理
tools:
  - Bash
  - Read
  - Glob
  - Grep
model: main
---

你是一位数据库专家，专精于：
- SQL 查询优化和索引设计
- 数据库 Schema 设计
- PostgreSQL / MySQL / SQLite 的最佳实践

分析数据库相关问题时，请给出具体的优化建议和 SQL 示例。
```

`tools` 字段也支持逗号分隔的字符串格式：`tools: Bash, Read, Glob`


## 内置 Agent 类型

系统内置了以下 Agent（可在 Task 工具中通过 `subagent_type` 指定）：

- **Explore**：代码库探索专家，使用 quick 模型。适合快速定位文件、搜索关键字、理解代码结构。只读模式，不能修改文件。可用工具：`Bash, Glob, Grep, Read, TodoWrite`
- **Plan**：架构规划专家，适合设计实现方案、评估技术选型。只读模式，不能修改文件。可用工具：`Bash, Glob, Grep, Read, TodoWrite`

除内置外，也可通过用户级或项目级 Agent 文件扩展更多类型。


## 查看与管理 Agent

```javascript
// 查看所有可用 Agent
const agents = sema.getAgentsInfo()
agents.forEach(a => {
  console.log(`${a.name} [${a.locate}]: ${a.description}`)
})

// 通过 API 添加 Agent（locate 必须为 'user' 或 'project'）
await sema.addAgentConf({
  name: 'my-agent',
  description: '我的自定义代理',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  prompt: '你是一个专业的代码质量检查代理...',
  model: 'main',
  locate: 'user',  // 必填：'user' 写入用户目录，'project' 写入项目目录
})
```


## 状态隔离

每个 SubAgent 拥有完全独立的状态：

- **独立的消息历史**：SubAgent 的对话不影响主 Agent
- **独立的 agentId**：主 Agent 使用 `'main'`，SubAgent 使用唯一的 taskId
- **工具限制**：SubAgent 不能创建新的 SubAgent（防止无限递归）


## 事件

SubAgent 运行时触发以下事件：

```javascript
// SubAgent 启动
sema.on('task:agent:start', ({ taskId, subagent_type, description, prompt }) => {
  console.log(`SubAgent 启动 [${taskId}]: ${subagent_type}`)
})

// SubAgent 完成
sema.on('task:agent:end', ({ taskId, status, content }) => {
  console.log(`SubAgent 完成 [${taskId}]: ${status}`)
  // status: 'completed' | 'failed' | 'interrupted'
})

// SubAgent 的工具执行（包含 agentId）
sema.on('tool:execution:complete', ({ agentId, toolName, summary }) => {
  if (agentId !== 'main') {
    console.log(`[SubAgent ${agentId}] ${toolName}: ${summary}`)
  }
})
```

SubAgent **不触发** `state:update`、`conversation:usage`、`todos:update` 等主 Agent 专用事件。

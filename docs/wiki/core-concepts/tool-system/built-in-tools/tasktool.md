# 子代理工具 Task

创建隔离的子代理（SubAgent）执行专项任务，结果返回给主 Agent 继续处理。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | `string` | ✓ | 3-5 字的任务简短描述 |
| `prompt` | `string` | ✓ | 详细的任务说明（传给 SubAgent 的完整上下文） |
| `subagent_type` | `string` | ✓ | SubAgent 类型名称（对应 AgentConfig.name） |

## 基本属性

- **isReadOnly**：`false`（子代理可能执行写操作）
- **权限**：无需权限
- **递归限制**：SubAgent 不能再创建 SubAgent（Task 工具不包含在 SubAgent 的工具列表中）


## 内置 SubAgent 类型

| 类型名 | 专长 |
|--------|------|
| `Bash` | 命令执行、git 操作、脚本运行 |
| `general-purpose` | 通用多步骤研究和执行任务 |
| `Explore` | 代码库快速探索和搜索 |
| `Plan` | 架构设计和实现方案规划 |

自定义类型通过 Agent 配置文件定义，详见 [SubAgent 子代理](wiki/core-concepts/advanced-topics/subagents)。


## 状态隔离

每个 SubAgent 拥有完全独立的状态：

- 独立的 `agentId`（随机生成的 nanoid）
- 独立的消息历史（不包含主 Agent 的对话历史）
- 独立的文件读取时间戳
- 独立的 Todo 列表

SubAgent 的工具执行完成后，**只有最终结果**返回给主 Agent。


## 事件

```javascript
// SubAgent 启动
sema.on('task:agent:start', ({ taskId, subagent_type, description, prompt }) => {
  console.log(`[${subagent_type}] 启动: ${description}`)
})

// SubAgent 完成
sema.on('task:agent:end', ({ taskId, status, content }) => {
  // status: 'completed' | 'failed' | 'interrupted'
  console.log(`SubAgent ${status}: ${content.slice(0, 100)}`)
})

// SubAgent 的工具执行（通过 agentId 区分）
sema.on('tool:execution:complete', ({ agentId, toolName, title, summary, content }) => {
  if (agentId !== 'main') {
    console.log(`  [SubAgent ${agentId}] ${toolName}: ${summary}`)
  }
})
```

SubAgent **不触发**以下主 Agent 专用事件：
`state:update`、`conversation:usage`、`todos:update`、`topic:update`


## 使用示例

```
# 让 Explore 代理分析认证系统
subagent_type: "Explore"
description: "分析认证系统"
prompt: "请找到所有与用户认证相关的文件，理解认证流程（登录、token验证、权限检查），
总结关键数据结构和接口，以及使用的第三方库。"

# 让 Plan 代理设计重构方案
subagent_type: "Plan"
description: "设计重构方案"
prompt: "基于现有代码，为认证系统从 session-based 迁移到 JWT 设计详细的实施方案，
包括：影响范围分析、分步迁移计划、风险评估。"
```

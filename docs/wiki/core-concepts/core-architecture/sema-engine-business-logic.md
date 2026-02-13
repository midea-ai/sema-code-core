# SemaEngine — 业务逻辑

`SemaEngine` 是 Sema Code Core 的核心引擎，负责协调所有子系统的初始化和运行时调度。它被 `SemaCore` 内部持有，外部不直接访问。

## 职责概述

- 初始化并管理所有服务（Skill、Command、Agent、MCP）
- 构建可用工具列表（内置 + MCP）
- 处理用户输入的完整流程（文件引用解析 → 系统提示词 → 对话）
- 根据模式（Agent/Plan）动态调整工具集
- 向事件总线发布各阶段事件


## 会话创建

```javascript
async createSession(sessionId?: string): Promise<void>
```

执行步骤：

```
1. 中止当前正在进行的请求（如有）
2. 异步启动 AgentsManager 初始化（不阻塞，但在 updateState('idle') 前需要完成）
3. 清空 StateManager 所有状态
4. initialize()：设置日志级别、SessionId、加载模型配置
5. 若传入 sessionId，从 ~/.sema/history/[sessionId].json 加载历史消息和 Todos
6. 异步初始化插件（不阻塞）：加载 Skill 注册表、加载自定义命令
7. 将历史消息和 Todos 写入主代理状态
8. 等待 AgentsManager 初始化完成
9. 触发 session:ready 事件，设置状态 → 'idle'
```

`session:ready` 事件数据：

```javascript
{
  workingDir: string
  sessionId: string
  historyLoaded: boolean      // 是否恢复了历史消息
  usage: { useTokens, maxTokens, promptTokens }
  projectInputHistory: string[] // 项目历史输入记录
}
```


## 用户输入处理流程

```javascript
processUserInput(input: string, originalInput?: string): void
```

整个处理流程（异步，非阻塞）：

```
1. StateManager 设置状态 → 'processing'
   emit state:update { state: 'processing' }

2. 构建工具列表（详见工具系统）

3. 构建 AgentContext（agentId、abortController、tools、model）

4. 保存原始输入到项目历史（ConfManager）

5. 处理系统命令
   若为系统命令，直接返回

6. 检测并处理自定义命令（替换输入文本）

7. 解析 @文件引用
   识别输入中的 @filepath 语法
   读取文件内容，构建 file:reference 数据
   emit file:reference { references[] }

8. 生成系统提示词（formatSystemPrompt）
   包含：工作目录、规则、Skill 摘要、Plan 模式提示等

9. 构建 additionalReminders（系统提醒）
   - 文件引用 systemReminders（每次均添加）
   - 首次查询时：Todos 提醒（有 TodoWrite 工具时）、Rules 提醒
   - Plan 模式首次查询时：Plan 模式专用提醒

10. 调用 Conversation.query()
    传入：消息历史 + 当前用户消息、系统提示词、AgentContext
    → 流式执行对话循环

11. 设置状态 → 'idle'
    emit state:update { state: 'idle' }
```


## 工具列表构建

每次处理用户输入前，SemaEngine 动态构建工具列表：

```
内置工具（由 getTools(coreConfig?.useTools) 返回）
    +
MCP 工具（来自已连接的 MCP 服务器）

→ 根据 useTools 配置过滤

→ Plan 模式：额外排除 TodoWrite 工具
```


## Agent 模式切换

```javascript
updateAgentMode(mode: 'Agent' | 'Plan'): void
```

切换模式时：
- 更新内部 `agentMode` 配置（通过 ConfManager）
- 若切换到 Plan 模式，重置 Plan 模式信息发送状态（`resetPlanModeInfoSent`）
- 下次处理用户输入时，自动重建工具列表并在 additionalReminders 中附加 Plan 提醒

如果在对话进行中（AI 调用 ExitPlanMode 工具）切换模式，会触发**上下文重建**（详见 [对话系统](./conversation-system.md)）。


## 中断与资源释放

```javascript
interruptSession(): void   // 中断当前请求，状态 → 'idle'
dispose(): void            // 清理所有资源（中止请求、清空状态、移除事件监听）
```


## 事件发布

SemaEngine 在各阶段发布以下事件：

| 阶段 | 事件 |
|------|------|
| 会话就绪 | `session:ready` |
| 开始处理 | `state:update { state: 'processing' }` |
| 文件引用 | `file:reference` |
| 对话消息 | `message:thinking:chunk`, `message:text:chunk`, `message:complete` |
| 工具执行 | `tool:permission:request`, `tool:execution:complete`, `tool:execution:error` |
| Token 统计 | `conversation:usage` |
| 上下文压缩 | `compact:exec` |
| 处理完成 | `state:update { state: 'idle' }` |
| 错误 | `session:error` |
| 无模型配置 | `config:no_models` |

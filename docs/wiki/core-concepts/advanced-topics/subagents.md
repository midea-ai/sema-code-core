# 子代理

子代理（Subagent）是通过 `Task` 工具启动的隔离 Agent，在独立上下文中执行任务并将结果返回给主 Agent。子代理与主会话共享同一个 `AbortController`，主会话中断时所有子代理同步中断。

系统内置了 `Explore` 和 `Plan` 两个子代理；也可以通过配置文件创建自定义子代理。

> SubAgent **永远不能**使用 `Task` 工具（系统自动过滤，防止无限递归）。


## Explore 子代理

Explore 是内置的代码库探索专用子代理，擅长快速在大型代码库中搜索和理解代码结构。

### 能力

- 使用 `Glob`、`Grep`、`Read`、`Bash`、`TodoWrite` 等工具快速探索代码库
- 多轮搜索：根据初步结果调整搜索策略
- 综合分析：汇总多个文件的信息，回答架构级问题
- **只读模式**：严禁创建、修改或删除任何文件；`Bash` 仅允许只读操作（`ls`、`git log`、`git diff` 等）
- 默认使用 **quick 模型**，响应更快


### 适用场景

| 场景 | 示例 |
|------|------|
| 文件定位 | "找到所有处理认证的文件" |
| 关键字搜索 | "搜索所有使用 `deprecated` 标记的函数" |
| 架构理解 | "解释这个项目的路由系统是如何工作的" |
| 依赖分析 | "找出哪些模块依赖了 UserService" |
| 代码规律提取 | "分析现有 API 接口的命名规范" |


### 使用方法

Explore 子代理通过 `Task` 工具调用，指定 `subagent_type: 'Explore'`：

```javascript
// AI 在对话中会这样调用 Task 工具（无需手动调用）:
{
  subagent_type: 'Explore',
  description: '探索认证系统',
  prompt: `请全面分析这个项目的认证系统：
  1. 找到所有认证相关文件
  2. 理解认证流程（登录、token 验证、权限检查）
  3. 识别使用的第三方库
  4. 总结关键的数据结构和接口`,
}
```

> `Task` 工具的参数只有 `subagent_type`、`description`、`prompt`，不支持在调用时指定模型。子代理使用的模型由 Agent 配置决定（Explore 默认为 quick 模型）。


### 详细程度

通过提示词控制探索的深度：

```
quick（快速）: 基础搜索，找到关键文件即可
medium（中等）: 适度探索，理解主要流程
very thorough（深度）: 全面分析，覆盖边缘情况和多种命名规范
```

示例：

```
"快速找到项目的入口文件"
→ quick：直接搜索 index.ts / main.ts / app.ts

"理解用户认证流程的实现细节"
→ medium：搜索认证相关文件，阅读核心逻辑

"完整分析整个权限控制系统，包括 RBAC 实现和中间件"
→ very thorough：系统性搜索所有相关文件和测试
```

## Plan 子代理

Plan 子代理是内置的架构规划专用子代理，用于在实现任务前设计方案、评估选项和创建分步计划。

### 能力

- 探索代码库，理解现有架构（工具：`Bash`、`Glob`、`Grep`、`Read`、`TodoWrite`）
- 设计实现方案，评估多种技术选型的权衡
- 创建结构化的分步执行计划，并列出关键文件
- 识别潜在的风险和依赖关系
- **只读模式**：严禁修改任何文件；`Bash` 仅允许只读操作
- 默认使用 **main 模型**，推理能力更强


### 与 Plan 模式的区别

| 特性 | Plan 子代理 | Plan 模式 |
|------|------------|----------|
| 运行方式 | 隔离的子 Agent | 主 Agent 的运行模式 |
| 影响范围 | 不影响主对话历史 | 影响当前会话 |
| 退出方式 | 任务完成自动结束 | 需要用户响应 ExitPlanMode |
| 适用场景 | 需要独立规划子任务 | 整体规划后再实现 |


### 使用方法

```javascript
// AI 调用 Task 工具时指定 subagent_type: 'Plan':
{
  subagent_type: 'Plan',
  description: '设计用户认证重构方案',
  prompt: `请为用户认证系统的重构设计一个详细方案：

背景：
- 当前使用 session-based 认证
- 需要支持移动端和第三方集成
- 目标：迁移到 JWT + OAuth2

请提供：
1. 当前架构分析（阅读现有代码）
2. 目标架构设计
3. 迁移风险评估
4. 分步实施计划（含回滚策略）
5. 关键文件变更清单`
}
```

### 典型输出结构

Plan 子代理的输出末尾会附带关键文件清单：

```markdown
## 架构分析

### 现状
- 当前使用 express-session + Redis 存储
- 认证逻辑分散在 3 个中间件中

### 问题
- 无法支持无状态水平扩展
- 移动端需要额外的 session 同步

## 实施计划

### Phase 1：基础设施
- [ ] 安装 jsonwebtoken、passport-jwt
- [ ] 创建 JwtService 和 TokenBlacklist
- [ ] 编写单元测试

### Phase 2：接口迁移
...

### Critical Files for Implementation
- src/auth/middleware.ts - 核心认证中间件
- src/models/User.ts - 用户模型
- src/config/session.ts - Session 配置
```

### 适用场景

- **重构规划**：在动手前先分析影响范围，制定安全的迁移路径
- **功能设计**：为复杂功能设计实现方案，再交给主 Agent 执行
- **技术选型**：探索代码库，评估引入新技术的成本和收益
- **依赖梳理**：分析模块依赖关系，规划安全的改动顺序

## 自定义子代理

通过创建 Agent 配置文件，可以定义专用于特定任务的子代理。

### Agent 文件格式

Agent 配置文件是带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: code-reviewer
description: 专业代码审查代理，擅长发现潜在问题和改进机会
tools:
  - Read
  - Glob
  - Grep
  - Bash
model: main
---

# 代码审查代理

你是一位拥有 10 年经验的资深软件工程师，专精于代码质量审查。

## 审查标准

在审查代码时，请关注：

1. **安全漏洞**：SQL 注入、XSS、CSRF、不安全的反序列化等 OWASP Top 10 问题
2. **性能问题**：N+1 查询、不必要的循环嵌套、内存泄漏
3. **错误处理**：未捕获的异常、不合理的错误忽略
4. **代码规范**：命名规范、注释质量、函数长度
5. **测试覆盖**：关键路径是否有测试

## 输出格式

对每个问题，请按以下格式输出：
- **位置**：`文件路径:行号`
- **类型**：Security / Performance / Error / Style / Test
- **严重性**：Critical / Warning / Suggestion
- **描述**：问题说明
- **建议**：修复方案
```


### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✓ | 唯一名称（Task 工具中用 `subagent_type` 引用，大小写不敏感） |
| `description` | `string` | ✓ | 功能描述（AI 据此选择合适的 Agent） |
| `tools` | `string[] \| '*'` | — | 可用工具列表，支持数组或逗号分隔字符串，`'*'` 表示所有工具，默认所有 |
| `model` | `string` | — | `'main'`（主模型，默认）或 `'quick'`（快速模型） |

Markdown 正文是 Agent 的系统提示词。


### 存放位置

| 级别 | 路径 | 适用范围 |
|------|------|---------|
| 项目级 | `.sema/agents/[name].md` | 仅当前项目 |
| 用户级 | `~/.sema/agents/[name].md` | 所有项目 |
| 内置 | 代码内置 | 全局 |

优先级：**项目级 > 用户级 > 内置**


### 通过 API 添加

```javascript
// 添加到用户级（写入 ~/.sema/agents/）
await sema.addAgentConf({
  name: 'code-reviewer',
  description: '专业代码审查代理',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  prompt: '你是一位资深代码审查专家...',
  model: 'main',
  locate: 'user',   // 必填：'user' 或 'project'
})

// 添加到项目级（写入 .sema/agents/）
await sema.addAgentConf({
  name: 'db-expert',
  description: '数据库设计与优化专家',
  tools: ['Read', 'Glob', 'Grep', 'Bash'],
  prompt: '你是一位数据库架构专家...',
  model: 'main',
  locate: 'project',
})
```

### 最佳实践

**专注单一职责**：每个 Agent 专注一类任务，避免"万能 Agent"

**明确工具限制**：根据任务需要精确配置 `tools`，最小权限原则

**结构化输出**：在提示词中明确输出格式，方便主 Agent 处理结果

**选择合适模型**：
- 代码分析、复杂推理：`model: main`
- 快速搜索、简单任务：`model: quick`


### 示例：数据库专家代理

`.sema/agents/db-expert.md`：

```markdown
---
name: db-expert
description: 数据库设计与优化专家
tools:
  - Read
  - Glob
  - Grep
  - Bash
model: main
---

你是一位数据库架构专家，专精于：
- PostgreSQL / MySQL / SQLite 的性能优化
- 索引设计和查询优化
- 数据库 Schema 设计和迁移策略
- ORM 最佳实践（Prisma, TypeORM, Sequelize）

分析数据库相关问题时，请：
1. 先理解现有 Schema 结构
2. 分析查询执行计划（EXPLAIN）
3. 给出具体的优化 SQL 和索引建议
4. 评估改动对现有数据的影响
```


## 事件监听

所有子代理的生命周期事件均通过以下事件上报：

```javascript
sema.on('task:agent:start', ({ taskId, subagent_type, description }) => {
  console.log(`子代理启动 [${subagent_type}]: ${description}`)
})

sema.on('task:agent:end', ({ taskId, status, content }) => {
  // status: 'completed' | 'interrupted' | 'failed'
  console.log(`子代理结束 [${status}]`)
  // content 包含统计摘要（token 用量、工具调用次数等）
})
```

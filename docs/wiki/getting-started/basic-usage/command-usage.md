# Command 命令使用

Command 是以 Markdown 文件形式存储的自定义快捷指令，允许你为常用操作定义命令名称，在对话中直接触发特定的提示词或工作流。支持参数占位符，同时内置了 `/clear`、`/compact`、`/quickchat` 等系统命令。

## 与 Skill 的区别

| 特性 | Command | Skill |
|------|---------|-------|
| 调用方式 | 用户直接 `/cmd` 触发 | AI 自动判断或用户引导调用 |
| 复杂度 | 简单提示词映射 | 完整工作流（含工具调用、fetch 流程等） |
| 参数支持 | `$ARGUMENTS` 占位符 | 自然语言参数解析 |
| 使用场景 | 常用操作的快捷方式 | 可复用的复杂工作流 |

## 命令存储位置与优先级

按从低到高的顺序加载，**后加载的覆盖先加载的**：

| 优先级 | 来源 | 路径 | 说明 |
|--------|------|------|------|
| 1（最低） | 插件级 | 已安装且启用的插件提供的 commands | 插件命令，格式：`插件名:命令名` |
| 2 | Sema 用户级 | `~/.sema/commands/` | 用户全局命令 |
| 3（最高） | Sema 项目级 | `<project>/.sema/commands/` | 项目专属命令 |

> **注意**：Sema 项目级的同名命令会覆盖用户级。插件来源的命令名为 `插件名:命令名` 格式。

## 创建命令文件

每个命令对应一个 `.md` 文件，命令名由文件路径自动生成（子目录用 `:` 分隔）：

```
.sema/commands/
├── fix-lint.md          → /fix-lint
├── run-tests.md         → /run-tests
└── frontend/
    └── generate.md      → /frontend:generate
```

### 文件格式

命令文件为带 frontmatter 的 Markdown 格式：

```markdown
---
description: 修复所有 lint 错误
argument-hint: <file-path>
---

请检查并修复 $ARGUMENTS 中的所有 lint 错误，遵循项目的 ESLint 配置。
```

### Frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | 命令描述，用于命令列表展示 |
| `argument-hint` | string \| string[] | 参数提示文本，如 `<file-path>` 或 `[pr-number] [priority]` |

**argument-hint 说明**：
- 单个参数：`<file-path>` 或 `<pr-number>`
- 多个参数：`[pr-number] [priority]` 会被自动解析为 `['pr-number', 'priority']`
- 可选参数：使用方括号 `[]` 包裹

## 参数传递

在命令内容中使用占位符引用参数：

| 占位符 | 说明 | 示例（调用 `/fix-lint src/components/Button.tsx`） |
|--------|------|------|
| `$ARGUMENTS` | 完整参数字符串 | 替换为 `src/components/Button.tsx` |
| `$0`, `$1`, … | 按位置索引的单个参数 | `$0` → `src/components/Button.tsx` |

```bash
# 调用命令并传入参数
/fix-lint src/components/Button.tsx
```

**参数处理规则**：
- 若命令内容中包含 `$ARGUMENTS`，会替换为完整参数字符串
- 若命令内容中包含 `$0`、`$1` 等位置占位符，依次替换为对应位置的参数
- 不传参数时，`$ARGUMENTS` 和位置占位符会被替换为空字符串
- 若命令内容中不包含任何占位符，传入的参数会被忽略

## 系统内置命令

以下命令由系统内置处理，无需创建文件：

| 命令 | 说明 |
|------|------|
| `/clear` | 清空当前会话的消息历史 |
| `/compact` | 压缩当前消息历史以减少 token 占用 |
| `/quickchat <question>` | 旁路问答：不影响主对话状态，回复通过 `quickchat:response` 事件返回 |

## 查看与管理命令

### 获取命令列表

```javascript
// 获取所有命令（异步，含缓存）
const commands = await sema.getCommandsInfo()
commands.forEach(cmd => {
  console.log(`/${cmd.name}: ${cmd.description}`)
})

// 强制刷新（命令文件变更后调用）
await sema.getCommandsInfo(undefined, true)
```

### 添加自定义命令

```javascript
await sema.addCommandConf({
  name: 'fix-lint',
  description: '修复 lint 错误',
  argumentHint: '<file-path>',
  prompt: '请检查并修复 $ARGUMENTS 中的所有 lint 错误。',
  locate: 'project',  // 'user' 或 'project'
})
```

### 删除命令

```javascript
// 删除命令（仅 Sema 来源可删，插件来源只读）
await sema.removeCommandConf('fix-lint')
```

> **注意**：插件来源的命令无法通过 API 删除，只能禁用对应插件。

### CommandConfig 接口

```typescript
interface CommandConfig {
  name: string                          // 命令名（如 "fix-lint" 或 "frontend:generate"）
  description: string                   // 命令描述
  argumentHint?: string | string[]      // 参数提示
  prompt: string                        // Markdown 正文（不含 frontmatter）
  locate?: 'user' | 'project' | 'plugin' // 作用域（addCommandConf 仅接受 'user' | 'project'）
  filePath?: string                     // 源 .md 文件路径
}
```

## 使用命令

在对话中输入 `/命令名` 即可触发对应命令，支持传入参数：

```
/fix-lint
/run-tests src/
/frontend:generate Button
/quickchat 你觉得这个架构怎么样？
```

> **内部机制**：Command 在 `processUserInput` 入口被识别并展开为对应的 Markdown prompt 后，再交给 LLM 处理。

## 命令命名规则

- 文件命名：`.md` 结尾的 Markdown 文件
- 命令名生成：文件路径去掉 `.md` 后缀，路径分隔符替换为冒号 `:`
- 示例：
  - `test.md` → `test`
  - `frontend/test.md` → `frontend:test`
  - `backend/api/v1.md` → `backend:api:v1`

## 最佳实践

### 1. 项目级 vs 用户级

- **项目级命令**（`.sema/commands/`）：团队共享的命令，如项目特定的测试、构建命令
- **用户级命令**（`~/.sema/commands/`）：个人常用命令，如代码审查、文档生成等

### 2. 参数设计

```markdown
---
description: 代码审查
argument-hint: [pr-number] [focus-area]
---

请审查 PR #$0 的代码变更，重点关注 $1 部分。
```

### 3. 命令组织

对于复杂项目，建议使用子目录组织命令：

```
.sema/commands/
├── test/
│   ├── unit.md        → /test:unit
│   ├── integration.md → /test:integration
│   └── e2e.md         → /test:e2e
├── deploy/
│   ├── staging.md     → /deploy:staging
│   └── production.md  → /deploy:production
└── docs/
    ├── generate.md    → /docs:generate
    └── check.md       → /docs:check
```

## 相关源码

- 命令管理器：`src/services/commands/commandsManager.ts`
- 命令类型定义：`src/types/command.ts`
- 命令执行逻辑：`src/services/commands/runCommand.ts`
- SemaCore 公共 API：`src/core/SemaCore.ts`

## 进一步了解

对于更复杂的可复用工作流（含 AI 自动调用、工具约束等），推荐使用 [Skill 使用](wiki/getting-started/basic-usage/skill-usage)；命令系统的更多细节参考 [Command 命令](wiki/core-concepts/advanced-topics/commands)。

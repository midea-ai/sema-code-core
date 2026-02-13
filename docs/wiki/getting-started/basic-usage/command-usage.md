# Command 使用

Command 是以 Markdown 文件形式存储的自定义快捷指令，允许你为常用操作定义命令名称，在对话中直接触发特定的提示词或工作流。支持传入参数，同时内置了 `/clear`、`/compact` 等系统命令。

## 与 Skill 的区别

| 特性 | Command | Skill |
|------|---------|-------|
| 存储格式 | Markdown 文件（.md） | Markdown 文件 |
| 复杂度 | 简单提示词映射 | 完整工作流 |
| 参数支持 | `$ARGUMENTS` 占位符 | 可配置 |
| 工具约束 | 无 | 可配置 |
| 模型指定 | 无 | 可配置 |


## 命令存储位置

Command 文件存放于以下两个目录，支持子目录结构：

- **项目级别**：`<项目根目录>/.sema/commands/`
- **用户级别**：`~/.sema/commands/`

当项目级别与用户级别存在同名命令时，**用户级别优先**。


## 创建命令文件

每个命令对应一个 `.md` 文件，命令名由文件路径自动生成（路径分隔符替换为 `:`）：

```
.sema/commands/
├── fix-lint.md          → /fix-lint
├── run-tests.md         → /run-tests
└── frontend/
    └── generate.md      → /frontend:generate
```

文件格式为带 frontmatter 的 Markdown：

```markdown
---
description: 修复所有 lint 错误
argument-hint: <file-path>
---

请检查并修复 $ARGUMENTS 中的所有 lint 错误，遵循项目的 ESLint 配置。
```

frontmatter 支持的字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `description` | string | 命令描述，未填写时默认为 "No description" |
| `argument-hint` | string | 参数提示文本，如 `<file-path>` |


## 参数传递

在命令内容中使用 `$ARGUMENTS` 作为占位符，调用时传入的参数会替换该占位符：

```
/fix-lint src/components/Button.tsx
```

若命令内容中不包含 `$ARGUMENTS`，传入的参数会追加到内容末尾。


## 系统内置命令

以下命令由系统内置处理，无需创建文件：

| 命令 | 说明 |
|------|------|
| `/clear` | 清空当前会话的消息历史 |
| `/compact` | 压缩当前消息历史以减少 token 占用 |


## 获取自定义命令

```javascript
const commands = await sema.getCustomCommands()
commands.forEach(cmd => {
  console.log(`${cmd.displayName}: ${cmd.description}`)
})
```

`CustomCommand` 结构：

```typescript
interface CustomCommand {
  name: string          // 命令名（如 "fix-lint" 或 "frontend:generate"）
  displayName: string   // 显示名（如 "/fix-lint" 或 "/frontend:generate"）
  description: string   // 命令描述
  argumentHint?: string // 参数提示文本
  filePath: string      // 源 .md 文件路径
  content: string       // Markdown 内容（不含 frontmatter）
  scope: 'user' | 'project' // 作用域
}
```


## 重新加载命令

当命令文件发生变化时，调用此方法清除缓存并刷新：

```javascript
sema.reloadCustomCommands()
```


## 使用命令

在对话中输入 `/命令名` 即可触发对应命令，支持传入参数：

```
/fix-lint
/run-tests src/
/frontend:generate Button
```


## 进一步了解

对于更复杂的可复用工作流，推荐使用 [Skill 使用](wiki/getting-started/basic-usage/skill-usage)，它提供了更完整的元数据配置、工具约束和模型指定能力。

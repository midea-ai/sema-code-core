# Skill 使用

Skill 是存储在 Markdown 文件中的可复用 AI 工作流。通过 Skill，你可以将常用的操作（如代码提交、代码审查、测试等）封装为标准化流程，在对话中直接调用。

## Skill 文件格式

Skill 采用带 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: commit
description: 按照项目规范创建 Git 提交
allowed-tools:
  - Bash
  - Read
  - Glob
when-to-use: 当用户需要提交代码时使用
model: sonnet
argument-hint: "可选的提交信息前缀"
version: "1.0.0"
---

# Git 提交 Skill

分析当前暂存的改动，按照以下规范创建提交：

1. 使用 `git diff --staged` 查看改动内容
2. 根据改动类型选择合适的前缀：`feat:` / `fix:` / `docs:` / `refactor:`
3. 提交信息保持简洁，不超过 72 字符
4. 如果有多个独立改动，考虑分次提交

请分析改动并创建规范的提交。
```


## Skill 元数据字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✓ | Skill 唯一名称（调用时使用） |
| `description` | `string` | ✓ | Skill 功能描述 |
| `allowed-tools` | `string[]` | — | 软约束：推荐使用的工具列表，支持数组或空格分隔的字符串 |
| `when-to-use` | `string` | — | 使用时机说明，会在系统提示中展示 |
| `model` | `string` | — | 指定模型：`haiku` / `sonnet` / `opus` / `inherit` |
| `max-thinking-tokens` | `number` | — | 最大思考 token 数 |
| `disable-model-invocation` | `boolean` | — | 禁用 LLM 调用，只返回 Skill 内容 |
| `argument-hint` | `string` | — | 调用时参数格式提示 |
| `version` | `string` | — | Skill 版本号 |


## 存放位置与优先级

Skill 文件支持两种组织方式：

**子目录方式（推荐）**：在 skills 目录下创建以 Skill 名命名的子目录，内含 `SKILL.md`（大小写不敏感，支持 `SKILL.md`、`skill.md`、`Skill.md`）：

```
.sema/skills/commit/SKILL.md
~/.sema/skills/commit/SKILL.md
```

**直接文件方式**：在 skills 目录下直接放置 `.md` 文件：

```
.sema/skills/commit.md
~/.sema/skills/commit.md
```

| 级别 | 路径 | 优先级 |
|------|------|--------|
| 项目级 | `.sema/skills/` | 高（覆盖同名用户级） |
| 用户级 | `~/.sema/skills/` | 低 |

同名 Skill：项目级优先于用户级。


## 创建 Skill

```bash
# 创建项目级 Skill（子目录方式）
mkdir -p .sema/skills/commit
cat > .sema/skills/commit/SKILL.md << 'EOF'
---
name: commit
description: 创建规范的 Git 提交
allowed-tools: [Bash, Read]
model: sonnet
---

分析 git diff --staged 的内容，创建符合 Conventional Commits 规范的提交信息。
EOF
```


## 查看已加载的 Skill

```javascript
const skills = sema.getSkillsInfo()
skills.forEach(skill => {
  console.log(`${skill.name} [${skill.locate}]: ${skill.description}`)
})
```

`SkillInfo` 结构：

```typescript
interface SkillInfo {
  name: string
  description: string
  locate: 'user' | 'project'   // 来源：user（用户级） 或 project（项目级）
}
```


## 在对话中调用 Skill

在用户输入中使用 `/skill-name` 语法触发 Skill：

```
/commit
/commit feat: 添加用户认证模块
/review src/auth.ts
```

AI 会自动调用 `Skill` 工具加载对应的 Skill 内容并执行。


## 示例：代码审查 Skill

`.sema/skills/review/SKILL.md`：

```markdown
---
name: review
description: 对指定文件进行代码审查
allowed-tools: [Read, Glob, Grep]
when-to-use: 用户需要审查代码质量时
model: opus
argument-hint: "要审查的文件路径"
---

# 代码审查

请对提供的代码文件进行全面审查，重点关注：

- **正确性**：逻辑是否正确，边界条件处理
- **性能**：是否存在明显的性能问题
- **安全性**：是否存在安全漏洞（SQL 注入、XSS 等）
- **可维护性**：代码可读性，是否过度复杂
- **最佳实践**：是否遵循该语言/框架的最佳实践

输出结构化的审查报告，每个问题注明文件和行号。
```

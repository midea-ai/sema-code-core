# Skill 使用

Skill 是存储在 Markdown 文件中的可复用 AI 工作流。通过 Skill，你可以将常用操作（如代码提交、代码审查、测试等）封装为标准化流程，由 AI 在合适时机自动调用，或在对话中直接触发。

## Skill 文件格式

Skill 采用带 YAML frontmatter 的 Markdown 文件，以子目录 + `SKILL.md` 的方式组织：

```markdown
---
name: commit
description: 按照项目规范创建 Git 提交
---

# Git 提交 Skill

分析当前暂存的改动，按照以下规范创建提交：

1. 使用 `git diff --staged` 查看改动内容
2. 根据改动类型选择合适的前缀：`feat:` / `fix:` / `docs:` / `refactor:`
3. 提交信息保持简洁，不超过 72 字符
4. 如果有多个独立改动，考虑分次提交

请分析改动并创建规范的提交。
```

### Frontmatter 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Skill 唯一名称，调用时使用（必填） |
| `description` | `string` | Skill 功能描述，AI 据此决定何时使用（必填） |

> Sema 的 Skill 解析器（`parseFile`）只读取 `name` / `description` / `prompt`（frontmatter 后的 Markdown 正文）。其它 Skills 常见字段（`allowed-tools`、`when-to-use`、`model`、`max-thinking-tokens` 等）不会被解析为运行时约束。如需类似能力，请用 [SubAgent](wiki/core-concepts/task-management/agent-task)。


## 存放位置与优先级

Skill 文件必须放在以 skill 名命名的**子目录**中，子目录下必须有 `SKILL.md`（大小写敏感）。

按从低到高的优先级加载，**同名 Skill 后加载的覆盖先加载的**：

| 优先级 | 来源 | 路径 |
|-------|------|------|
| 4（最低） | 内置 | 随 Sema Core 提供，无磁盘文件 |
| 3 | 插件级 | 已安装且启用的插件提供的 skills |
| 2 | 用户级 | `~/.sema/skills/` |
| 1（最高） | 项目级 | `<project>/.sema/skills/` |

### 内置 Skill

Sema Core 自带 `sema-extend`：用户在对话里要求安装、配置或移除扩展（skill、MCP server、agent、command、hook、plugin）时，模型据此把内容装到本机正确的位置，并按各类型的格式校验。例如直接说"帮我安装这个 skill：<GitHub 链接>"。

- 默认装到用户级，用户明确说"给这个项目"时才装项目级。
- 安装后新开会话即生效，无需重启。
- 插件与插件市场不会被手动拷贝，模型会引导到宿主的插件页面添加。
- 内置 Skill 始终启用，不可删除、不支持启用/禁用开关（`status` 恒为 `true`）；调用时不弹权限询问（其指导下的写文件、执行命令仍各自询问）。放一个同名的用户级或项目级 Skill 即可覆盖它。

示例目录结构：

```
.sema/skills/
├── commit/
│   └── SKILL.md
└── review/
    └── SKILL.md

~/.sema/skills/
└── deploy/
    └── SKILL.md
```


## 创建 Skill

```bash
mkdir -p .sema/skills/commit
cat > .sema/skills/commit/SKILL.md << 'EOF'
---
name: commit
description: 创建符合 Conventional Commits 规范的 Git 提交
---

分析 git diff --staged 的内容，创建符合 Conventional Commits 规范的提交信息。
EOF
```

无需重启 Sema Core：新建会话时会自动重新加载，也可调用 `getSkillsInfo(undefined, true)` 立即刷新。


## 查看与刷新 Skill

```javascript
// 获取所有 Skill（含缓存）
const skills = await sema.getSkillsInfo()

skills.forEach(skill => {
  console.log(`${skill.name} [${skill.locate}]: ${skill.description}`)
})

// 强制从磁盘重新加载
await sema.getSkillsInfo(undefined, true)

// 删除某个 Skill（仅用户级/项目级可删，内置与插件来源只读）
// 会删除对应的 SKILL.md 及其所在目录
await sema.removeSkillConf('commit')
```

`SkillConfig` 接口：

```typescript
// SkillScope = 'user' | 'project' | 'plugin' | 'builtin'

interface SkillConfig {
  name: string
  description: string
  prompt: string         // SKILL.md 正文（不含 frontmatter）
  locate?: SkillScope    // 来源层级
  filePath?: string      // SKILL.md 绝对路径
}
```


## 在对话中触发 Skill

Sema 内置 `skill` 工具，AI 在判断需要时会自动调用对应的 Skill。用户也可以在输入中显式引导：

```
帮我用 commit skill 提交当前改动
```

> Skill 注入方式：在首次查询时，`getSkillTypesDescription()` 生成所有可用 Skill 的 `name: description` 列表，通过 `<system-reminder>` 注入系统提示词。AI 根据描述决定何时调用哪个 Skill，具体内容由 `skill` 工具按需读取。


## 示例：代码审查 Skill

`.sema/skills/review/SKILL.md`：

```markdown
---
name: review
description: 对指定文件进行代码审查，覆盖正确性、性能、安全、可维护性
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




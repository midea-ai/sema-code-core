# Skill 支持

Skill 系统允许将常用的 AI 工作流封装为可复用的 Markdown 文件，在对话中通过 `/skill-name` 语法直接调用。

## 系统架构

```
.sema/skills/[name]/SKILL.md    ←── 项目级（高优先级）
~/.sema/skills/[name]/SKILL.md  ←── 用户级

         ↓ 加载（initializeSkillRegistry）

    SkillRegistry（Map<name, Skill>）

         ↓ AI 调用 Skill 工具

    findSkill(name) → 返回 Skill 内容 → LLM 执行
```


## Skill 文件格式

技能文件支持两种存放方式：

1. **子目录方式**（推荐）：在 skills 目录下创建以技能名命名的子目录，内含 `SKILL.md`（大小写不敏感，支持 `SKILL.md` / `skill.md` / `Skill.md`）
2. **直接文件方式**：在 skills 目录下直接放置 `.md` 文件

```markdown
---
name: review
description: 对代码进行全面审查，输出结构化报告
allowed-tools:
  - Read
  - Glob
  - Grep
when-to-use: 用户需要代码审查或质量检查时
model: opus
max-thinking-tokens: 10000
disable-model-invocation: false
argument-hint: "要审查的文件路径或目录"
version: "1.0.0"
---

# 代码审查 Skill

你是一位资深代码审查专家。请对提供的代码进行全面审查：

## 审查维度

1. **正确性**：逻辑是否正确，边界条件是否处理
2. **性能**：是否存在明显的性能瓶颈
3. **安全性**：是否存在安全漏洞（OWASP Top 10）
4. **可维护性**：代码可读性和复杂度
5. **最佳实践**：是否遵循语言/框架规范

## 输出格式

对每个问题，请提供：
- 文件路径和行号
- 问题描述
- 严重程度（Critical / Warning / Suggestion）
- 修复建议
```


## 元数据字段详解

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | ✓ | 唯一名称，用于 `/name` 调用 |
| `description` | `string` | ✓ | 功能描述（显示在工具列表中） |
| `allowed-tools` | `string[]` | — | **软约束**：推荐使用的工具（AI 可自行决定）。支持 YAML 数组或空格分隔字符串 |
| `when-to-use` | `string` | — | 使用时机（追加到 description 后，注入系统提示帮助 AI 自动选择） |
| `model` | `string` | — | 指定模型：`haiku`/`sonnet`/`opus`/`inherit` |
| `max-thinking-tokens` | `number` | — | 最大思考 token 数（Extended Thinking） |
| `disable-model-invocation` | `boolean` | — | 为 `true` 时只返回 Skill 内容，不继续触发 LLM 推理 |
| `argument-hint` | `string` | — | 调用时参数格式提示（显示给 LLM） |
| `version` | `string` | — | 版本号（供管理使用） |


## 参数传递

通过 `args` 字段传入参数：

- 若 Skill 内容包含 `$ARGUMENTS` 占位符，所有占位符会被替换为实际参数
- 若不含占位符，参数以 `ARGUMENTS: <args>` 形式追加到内容末尾

```javascript
// AI 调用示例
{ skill: 'review', args: 'src/components/Button.tsx' }
```


## 注册表 API

Skill 注册表在 `SemaEngine.createSession()` 时初始化（不阻塞会话创建）：

```javascript
// 初始化（内部使用，按 workingDir + 目录 mtime 缓存）
initializeSkillRegistry(workingDir)

// 查找 Skill
const skill = findSkill('review')

// 获取所有 Skill 的结构化信息
const skills = getSkillsInfo()
// SkillInfo[]: { name, description, locate }
// locate: 'project' | 'user'

// Markdown 摘要（注入系统提示词，让 AI 知道可用哪些 Skill）
const summary = getSkillsSummary()

// 清除注册表缓存（会话重建或测试时使用）
clearSkillRegistry()
```


## 调用流程

1. 用户输入 `/commit` 或 AI 自行决定调用 Skill
2. AI 调用内置 `Skill` 工具：`{ skill: 'commit', args: '...' }`
3. `Skill` 工具从注册表查找 `commit` Skill；未找到时返回可用 Skill 列表
4. 将 Skill 内容（含 `allowed-tools` 软约束提示）返回给 LLM
5. LLM 按 Skill 内容执行任务
6. 权限检查：触发 `genToolPermission`，展示 Skill 名称和描述供用户确认


## 最佳实践

**Skill 命名**：使用动词短语，如 `commit`、`review`、`test`、`deploy`

**工具约束**：`allowed-tools` 只是建议，AI 可能使用其他工具。若需严格限制，应在 Skill 正文中明确说明。

**模型选择**：
- 简单任务（commit, format）：`model: haiku`（快速、低成本）
- 复杂分析（review, debug）：`model: opus`（最强能力）
- 默认：`model: inherit`（使用主模型）

**版本管理**：将 `.sema/skills/` 纳入 Git，团队共享 Skill。

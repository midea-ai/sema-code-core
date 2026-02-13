# 技能工具 Skill

加载并调用预定义的 Skill 工作流，将 Skill 内容返回给 LLM 执行。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `skill` | `string` | ✓ | Skill 名称（对应 SKILL.md 的 `name` 字段） |
| `args` | `string` | — | 传递给 Skill 的参数（在 Skill 内容中以 `$ARGUMENTS` 引用） |

## 基本属性

- **isReadOnly**：`false`（串行执行）
- **权限**：调用时展示 Skill 名称与描述，由用户确认


## 执行流程

```
AI 调用 Skill 工具
      │
      ▼
validateInput：从 SkillRegistry 查找 skill
      │
   找到？
   ├─ 否 → 返回错误："Skill 'xxx' not found. Available skills: ..."
   └─ 是 ↓
      │
      ▼
genToolPermission：展示 Skill 名称与描述，等待用户确认
      │
      ▼
call：处理 $ARGUMENTS 替换，构建返回内容
      │
      ▼
返回格式化的 Skill 内容给 LLM
      │
      ▼
LLM 按 Skill 内容执行（遵循 allowed-tools 软约束）
```


## 返回内容

Skill 工具返回给 LLM 的内容格式如下：

```
# Skill Activated: commit

Base directory for this skill: .sema/skills

Arguments: feat: 添加用户认证模块   （若有 args）

[Skill 的 Markdown 正文内容]

---

<system-reminder>
While working on this skill, you should prioritize using the following tools: Bash, Read.
These tools are recommended for this skill's workflow. You may use other tools if absolutely necessary.
</system-reminder>

---

Now that you have loaded the skill instructions, please proceed with the task based on the guidelines above.
```

LLM 收到此内容后，按照 Skill 正文的指令执行实际操作。


## $ARGUMENTS 替换逻辑

传入 `args` 时的处理规则：

1. 若 Skill 正文中包含 `$ARGUMENTS` 占位符 → 将所有 `$ARGUMENTS` 替换为传入的 args 值
2. 若 Skill 正文中**不含** `$ARGUMENTS` → 在正文末尾追加 `\n\nARGUMENTS: {args}`


## allowed-tools 约束

Skill 的 `allowed-tools` 字段是**软约束**（建议），通过 `<system-reminder>` 注入 LLM 上下文，提示优先使用指定工具。LLM 可以根据实际需要使用其他工具。若需严格限制，应在 Skill 正文中明确说明。


## 使用示例

```
# 调用 commit skill（无参数）
skill: "commit"

# 调用 commit skill（带参数）
skill: "commit"
args: "feat: 添加用户认证模块"

# 调用代码审查 skill
skill: "review"
args: "src/auth/AuthService.ts"
```


## Skill 优先级

查找 Skill 时：项目级（`.sema/skills/`）优先于用户级（`~/.sema/skills/`）。同名 Skill，项目级版本会覆盖用户级版本。

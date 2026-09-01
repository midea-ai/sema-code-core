# 内置资源目录

生态市场的内置资源清单。加新资源只需往 `skills/` 丢目录（含 `SKILL.md`，可选 `card.json`）或远程配置 `<id>.json`（card + source），往 `mcp/` 丢 json（card + server）。页面按分类分组展示，组内按 `card.order` 升序（缺省排最后）。

## Skills（按页面顺序）

### Office 办公（doc）

| 名称 | id | 来源 |
|---|---|---|
| Word 文档 | minimax-docx | MiniMax-AI/skills |
| Excel 表格 | minimax-xlsx | MiniMax-AI/skills |
| PPT 演示文稿 | pptx-generator | MiniMax-AI/skills |
| PDF 文档 | minimax-pdf | MiniMax-AI/skills |

### 职场效率（office）

| 名称 | id | 来源 |
|---|---|---|
| 决策备忘录 | decision-memo | mohitagw15856/pm-claude-skills |
| 文档转演示稿 | deck-from-doc | mohitagw15856/pm-claude-skills |
| 合同风险审查 | contract-review | mohitagw15856/pm-claude-skills |
| 预算差异分析 | budget-variance-analysis | mohitagw15856/pm-claude-skills |

### 写作沟通（writing）

| 名称 | id | 来源 |
|---|---|---|
| 去 AI 味写作 | avoid-ai-writing | wshobson/agents |

### 研发效率（dev）

| 名称 | id | 来源 |
|---|---|---|
| 结构化头脑风暴 | brainstorming | obra/superpowers |
| 写实施计划 | writing-plans | obra/superpowers |
| 系统性排障 | systematic-debugging | obra/superpowers |
| 代码审查 | code-review | coderabbitai/skills |
| 仓库知识库生成 | wiki-page-writer | microsoft/skills |
| 文档与架构决策记录 | documentation-and-adrs | addyosmani/agent-skills |
| 架构图生成 | archify | tt-a1i/archify |

### 网页站点（web）

| 名称 | id | 来源 |
|---|---|---|
| 前端开发 | frontend-dev | MiniMax-AI/skills |
| 落地页生成 | landing-page-generator | alirezarezvani/claude-skills |

### 移动开发（mobile）

| 名称 | id | 来源 |
|---|---|---|
| iOS 开发 | ios-application-dev | MiniMax-AI/skills |
| Android 开发 | android-native-dev | MiniMax-AI/skills |
| Flutter 开发 | flutter-dev | MiniMax-AI/skills |
| React Native 开发 | react-native-dev | MiniMax-AI/skills |

### 设计创意（design）

| 名称 | id | 来源 |
|---|---|---|
| 着色器视效 | shader-dev | MiniMax-AI/skills |

### 视频动画（media）

| 名称 | id | 来源 |
|---|---|---|
| Remotion 视频制作 | remotion-best-practices | remotion-dev/skills |

### 其他

| 名称 | id | 来源 |
|---|---|---|
| 技能制作 | skill-creator | 本地目录 |

## MCP

### 网络工具（network）

| 名称 | id |
|---|---|
| 网页抓取 | fetch |
| 浏览器自动化 | playwright |

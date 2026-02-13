# 交互工具 AskUserQuestion

向用户提出问题，获取用户的选择或输入，用于需要人工决策的场景。

## 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `questions` | `Question[]` | ✓ | 问题列表（1-4 个） |
| `answers` | `Record<string, string>` | — | 已收集的答案（内部使用） |
| `metadata` | `Metadata` | — | 可选元数据，用于追踪分析，不展示给用户 |

### Question 结构

```javascript
interface Question {
  question: string      // 问题文本（应以问号结尾）
  header: string        // 短标签（最多 12 字符），如 "框架选择"
  options: Option[]     // 2-4 个选项
  multiSelect?: boolean // 是否多选，默认 false
}

interface Option {
  label: string        // 选项显示文本（简洁，1-5 个词）
  description: string  // 选项说明（解释选择该选项的含义及权衡）
}

interface Metadata {
  source?: string      // 问题来源标识，如 "remember"，用于分析追踪
}
```

## 基本属性

- **isReadOnly**：`true`
- **权限**：无需单独权限，通过 `ask:question:request` 事件触发交互


## 触发流程

```
AI 调用 AskUserQuestion
      │
      ▼
emit ask:question:request
      │
      ▼
等待 ask:question:response
      │
      ▼
answers 返回给 AI，AI 据此继续执行
```


## 回应方式

监听 `ask:question:request` 事件，展示问题给用户，收集回答后通过 `ask:question:response` 事件响应：

```javascript
sema.on('ask:question:request', (data) => {
  // data.agentId   - 发起问题的代理 ID
  // data.questions - 问题列表（AskQuestion[]）
  // data.metadata  - 可选元数据

  // 收集用户答案后发出响应
  sema.emit('ask:question:response', {
    agentId: data.agentId,
    answers: {
      'question-0': 'react',      // 单选：直接返回选项 label
      'question-1': 'a,b,c',      // 多选：多个选项 label 以逗号分隔
    }
  })
})
```

answers 的 key 格式为 `question-{index}`（从 0 开始），多选时 value 为多个 label 以英文逗号拼接。


## 使用示例

AI 在以下场景会调用此工具：

```
# 技术选型
questions: [{
  question: "这个功能使用哪个状态管理库？",
  header: "状态管理",
  options: [
    { label: "Redux Toolkit", description: "成熟方案，适合大型项目" },
    { label: "Zustand", description: "轻量简洁，适合中小型项目" },
    { label: "Jotai", description: "原子化状态，适合细粒度更新" }
  ]
}]

# 多选配置
questions: [{
  question: "需要哪些功能模块？",
  header: "功能模块",
  multiSelect: true,
  options: [
    { label: "用户认证", description: "登录、注册、权限管理" },
    { label: "文件上传", description: "支持图片和文档" },
    { label: "消息推送", description: "WebSocket 实时通知" },
    { label: "数据导出", description: "CSV 和 Excel 格式" }
  ]
}]
```


## 使用建议

- 用户也可以在问题选项之外直接输入文本（"Other" 选项），AI 会收到自定义文本作为答案。
- 选项描述（`description`）应清晰说明该选项的含义和适用场景，帮助用户做出明智决策。
- 如果推荐某个选项，将其置于选项列表第一位，并在 label 末尾加上 "(Recommended)"。
- 在 Plan 模式中，使用此工具澄清需求或选择方案，不要用它询问"计划是否就绪"——那应该使用 ExitPlanMode。

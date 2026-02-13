# 引言：Agent 基础

## 什么是 Agent

Agent（代理）是能够感知环境、做出决策并采取行动的 AI 系统。与简单的问答 AI 不同，Agent 能够：

- **调用工具**：读写文件、执行命令、搜索代码、调用外部 API
- **多步推理**：将复杂任务分解为多个步骤，逐步执行
- **感知结果**：观察工具执行结果，据此调整后续行动
- **循环执行**：重复"思考 → 行动 → 观察"直到完成目标


## Sema Agent 工作原理

```mermaid
flowchart TD
    A([用户输入]) --> B{自动压缩检查\n仅主 Agent}
    B -- 需要压缩 --> C[压缩历史消息]
    B -- 无需压缩 --> D
    C --> D[调用 LLM\nqueryLLM]
    D --> E[emit message:complete\nemit conversation:usage]
    E --> F{有工具调用？}
    F -- 否 --> G[finalizeMessages\n结束本轮]
    F -- 是 --> H{所有工具\n均只读？}
    H -- 是 --> I[runToolsConcurrently\n并发执行]
    H -- 否 --> J[runToolsSerially\n串行执行]
    I --> K[收集工具结果]
    J --> K
    K --> L{检测到\nrebuildContext 信号？}
    L -- 是 --> M[重新获取工具集\n重新生成系统提示\n重建消息历史]
    L -- 否 --> N[追加消息历史]
    M --> O[递归调用 query]
    N --> O
    O --> D
```

每轮对话循环包含：

1. **调用 LLM**：发送消息历史和工具定义，获取流式响应
2. **收集响应**：接收 thinking 内容、text 内容、tool_use 块
3. **执行工具**：按并发/串行策略执行所有工具调用
4. **汇总结果**：将工具结果追加到消息历史
5. **继续循环**：重复直到 LLM 不再发起工具调用


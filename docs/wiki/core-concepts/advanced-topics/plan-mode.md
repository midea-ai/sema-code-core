# Plan 模式

Plan 模式是一种受限的 Agent 运行模式，专为分析、规划和方案设计场景而设计。在 Plan 模式下，AI 通过系统提示约束（soft constraint）被引导只做分析和规划，而不执行实际修改。

## Plan 模式 vs Agent 模式

| 特性 | Plan 模式 | Agent 模式 | 相关工具 |
|------|----------|-----------|-------------|
| 文件读取 | ✓ | ✓ | Read |
| 代码搜索 | ✓ | ✓ | Grep, Glob |
| 文件编辑 | 软限制（system-reminder 约束） | ✓ | Edit, NotebookEdit, Write |
| 命令执行 | ✓ | ✓ | Bash |
| TodoWrite | ✗（硬移除） | ✓ | TodoWrite |
| 用户交互 | ✓ | ✓ | AskUserQuestion |
| 其他工具 | ✓| ✓ | Skill, Task, ExitPlanMode |

### 限制机制说明

Plan 模式的限制分为两层：

- **硬限制**：`TodoWrite` 工具从工具列表中直接移除，AI 无法调用
- **软限制（system-reminder）**：在每次用户消息中注入 `<system-reminder>`，明确告知 AI 不得执行编辑操作（Edit, NotebookEdit, Write等）。这是 prompt 层面的约束，依赖模型遵守，而非工具层面的强制拦截

AI 在 Plan 模式下，进行分步骤引导，最后编写计划文件（system-reminder 中明确只允许写入 plan 文件）。

### prompt 步骤引导

通过 `system-reminder` 引入plan流程，流程的核心目标是通过结构化的探索、设计和审核，确保最终制定的执行计划是准确且高质量的。整个流程分为五个阶段，每个阶段都有其特定的目标和操作方式。

#### 阶段一：初步理解 (Initial Understanding)

**目标**：通过探索代码库，全面理解用户的请求和与之相关的代码。

**核心操作**：**按顺序启动 "Explore" 智能体。**

1.  **聚焦**：专注于理解用户请求和相关代码。
2.  **顺序启动**：
    *   每次只能启动一个 "Explore" 智能体，等待其完成后再启动下一个。
    *   **数量原则**：力求使用最少的智能体（通常1个即可）。最多不超过3个。
        *   **1个**：适用于任务范围明确（如已知文件路径）、进行小范围修改。
        *   **多个**：适用于范围不确定、涉及多个代码区域或需要了解现有模式的情况。
3.  **递进探索**：如果使用多个智能体，后一个智能体的搜索重点应基于前一个智能体的发现来调整。

#### 阶段二：设计 (Design)

**目标**：基于阶段一的探索结果，设计出实现方案。

**核心操作**：**启动 "Plan" 智能体(s) 来设计方案。**

*   **并行启动**：可以并行启动最多1个智能体。
*   **是否启动**：
    *   **默认启动**：对于大多数任务，都应启动至少1个"Plan"智能体，以验证理解和考虑替代方案。
    *   **可以跳过**：仅适用于真正微不足道的任务（如修正拼写错误、单行修改、简单重命名）。
*   **给智能体的提示**：在启动智能体时，需要提供全面的背景信息，包括：
    *   阶段一探索的发现（文件名、代码路径追踪）。
    *   用户的需求和约束条件。
    *   要求其产出一个详细的实施方案。

#### 阶段三：审核 (Review)

**目标**：审核阶段二产出的方案，确保其符合用户意图。

**核心操作**：**人工审核与用户确认。**

1.  **深入阅读**：仔细阅读方案中提到的关键文件，加深理解。
2.  **对齐目标**：确保方案与用户最初的要求完全一致。
3.  **澄清疑问**：如果还有任何不明确的地方，可以使用 **AskUserQuestion** 工具向用户提问，以澄清需求或在不同方案间做出选择。

#### 阶段四：最终方案 (Final Plan)

**目标**：将最终确定的方案写入计划文件（唯一可编辑的文件）。

**核心操作**：**撰写最终方案。**

*   **内容精简**：只包含最终推荐的方案，而非所有备选方案。
*   **详略得当**：方案既要简洁明了，便于快速浏览，又要足够详细，以便后续有效执行。
*   **必须包含**：
    *   待修改的关键文件路径。
    *   **验证部分**：描述如何端到端地测试这些修改（例如：如何运行代码、使用MCP工具、运行测试）。

#### 阶段五：退出计划模式 (ExitPlanMode)

**目标**：在完成所有规划后，通知用户规划阶段结束。

**核心操作**：**调用 `ExitPlanMode` 工具。**

*   **关键节点**：AI的回合必须以使用 **AskUserQuestion** 工具 或 调用 **ExitPlanMode** 工具 来结束。
*   **重要**：
    *   **AskUserQuestion** 仅用于在规划过程中（通常在阶段三）向用户提问以获取信息。
    *   **ExitPlanMode** 用于在最终方案制定完成后，请求用户批准该方案。
    *   **绝对不要** 以任何其他形式（如文本提问："这个方案可以吗？"）来请求用户批准。请求批准的唯一方式是调用 `ExitPlanMode` 工具。

## 启用 Plan 模式

```javascript
sema.updateAgentMode('Plan')
```

切换后，下次 `processUserInput()` 调用时生效。系统会：
1. 从工具列表中移除 `TodoWrite`
2. 在用户消息中注入 Plan 模式的 system-reminder，引导 AI 只做规划


## 退出 Plan 模式

AI 完成规划后，调用 `ExitPlanMode` 工具发起退出请求，流程如下：

### 1. AI 调用 ExitPlanMode

```
AI 调用 ExitPlanMode({
  planFilePath: '/path/to/plan.md',  // 计划文件的绝对路径（.md 文件）
})
```

### 2. 触发 `plan:exit:request` 事件

工具读取计划文件内容后，向宿主层发出事件，并**暂停等待**用户响应：

```javascript
sema.on('plan:exit:request', ({ agentId, planFilePath, planContent, options }) => {
  // 展示计划内容给用户
  console.log('AI 的执行计划:\n', planContent)

  // options 为选项对象，key 为选项标识，value 为展示文案
  // { startEditing: '开始代码编辑', clearContextAndStart: '清理上下文，并开始代码编辑' }
  showOptions(options)
})
```

### 3. 用户响应

```javascript
sema.respondToPlanExit({
  agentId: data.agentId,
  selected: 'startEditing',
  // 或 'clearContextAndStart'
})
```

`respondToPlanExit` 内部会向 EventBus 发送 `plan:exit:response` 事件，解除工具内部的等待。

### 4. 模式切换与上下文重建

收到响应后，ExitPlanMode 工具会调用 `getConfManager().updateAgentMode('Agent')` 切换回 Agent 模式，并根据用户选择重建上下文：

| 选项 | 行为 |
|------|------|
| `startEditing` | 切换到 Agent 模式，**保留**对话历史，TodoWrite 重新可用 |
| `clearContextAndStart` | 切换到 Agent 模式，**清空**对话历史，以计划内容作为新消息开始 |

选择 `clearContextAndStart` 时还会触发 `plan:implement` 事件：

```javascript
sema.on('plan:implement', ({ planFilePath, planContent }) => {
  console.log('计划已确认，开始实施')
})
```

工具最终通过 `controlSignal.rebuildContext` 通知 Conversation 层进行上下文重建。


## 完整工作流示例

```javascript
// 1. 启用 Plan 模式
sema.updateAgentMode('Plan')

// 2. 监听计划完成
sema.on('plan:exit:request', async ({ agentId, planContent, options }) => {
  // 在 UI 中展示计划
  displayPlan(planContent)

  // 获取用户选择
  const choice = await promptUser('选择执行方式', options)

  sema.respondToPlanExit({ agentId, selected: choice })
})

// 3. 计划确认后开始执行（仅 clearContextAndStart 时触发）
sema.on('plan:implement', ({ planContent }) => {
  console.log('开始按计划执行...')
})

// 4. 发送分析请求
await sema.createSession()
sema.processUserInput('分析认证模块的实现方式，设计重构方案')
```


## 适用场景

- **代码重构规划**：分析现有代码，设计重构步骤
- **架构设计**：探索代码库，评估技术方案
- **复杂任务分解**：将大任务拆分为可执行的步骤清单
- **风险评估**：在执行前评估改动的影响范围

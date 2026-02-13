# 管理器层

管理器层由四个单例类组成，各自负责不同维度的状态管理，通过单例模式在整个应用生命周期内共享。


## StateManager

**职责**：全局会话状态管理，支持按 `agentId` 隔离的多 Agent 状态。

### 隔离状态（per agentId）

每个 Agent 独立维护：

| 状态 | 类型 | 说明 |
|------|------|------|
| `statesMap` | `'idle' \| 'processing'` | 当前运行状态（含 previousState） |
| `messageHistoryMap` | `Message[]` | 对话消息历史 |
| `todosMap` | `TodoItemWithId[]` | 任务列表 |
| `readFileTimestampsMap` | `Record<string, number>` | 文件读取时间戳（用于 Edit 工具验证） |

### 共享状态（跨所有 Agent）

| 状态 | 类型 | 说明 |
|------|------|------|
| `sessionId` | `string` | 当前会话 ID |
| `globalEditPermissionGranted` | `boolean` | 是否已授予全局文件编辑权限 |
| `planModeInfoSent` | `boolean` | Plan 模式提示是否已发送 |
| `currentAbortController` | `AbortController` | 当前中断控制器 |

### 关键方法

```javascript
// 获取指定 Agent 的状态访问器
const agentState = stateManager.forAgent(agentId)

// AgentStateAccessor 提供的方法
agentState.getMessageHistory()                // 获取消息历史
agentState.setMessageHistory(messages)        // 设置消息历史
agentState.finalizeMessages(messages)         // 保存消息并将状态置为 idle
agentState.getCurrentState()                  // 获取运行状态
agentState.updateState('processing')          // 设置运行状态
agentState.getTodos()                         // 获取 Todos
agentState.setTodos(todos)                    // 设置 Todos
agentState.updateTodosIntelligently(todos)    // 智能更新 Todos
agentState.clearTodos()                       // 清理 Todos（SubAgent 专用）
agentState.getReadFileTimestamps()            // 获取全部文件时间戳
agentState.getReadFileTimestamp(filePath)     // 获取单个文件时间戳
agentState.setReadFileTimestamp(filePath, ts) // 设置单个文件时间戳
agentState.clearAllState()                    // 清理该 Agent 全部隔离状态（SubAgent 专用）

// 智能更新 Todos 逻辑：
// 若新 todos 均带 id 且是当前列表的子集 → 只更新匹配项
// 否则 → 完全替换
agentState.updateTodosIntelligently(newTodos)

// 授予全局文件编辑权限（整个会话有效）
stateManager.grantGlobalEditPermission()
stateManager.hasGlobalEditPermission()

// 会话 ID 管理（设置时自动重置全局编辑权限）
stateManager.setSessionId(sessionId)
stateManager.getSessionId()

// Plan 模式信息发送标记
stateManager.markPlanModeInfoSent()
stateManager.isPlanModeInfoSent()
stateManager.resetPlanModeInfoSent()
```

### MAIN_AGENT_ID

主 Agent 使用常量 `MAIN_AGENT_ID`（值为 `'main'`）作为 agentId，SubAgent 使用 nanoid 生成的随机 ID。

只有主 Agent 才会触发 `state:update` 和 `todos:update` 全局事件；SubAgent 的状态变更不对外广播。


## ConfManager

**职责**：配置文件的读写与管理。内部类名为 `ConfigManager`，通过 `getConfManager()` 获取全局单例。

**持久化路径**：`~/.sema/projects.conf`

### 管理的配置

**核心配置（SemaCoreConfig）**：控制实例行为，通过 `setCoreConfig()` 初始化，通过 `updateCoreConfig()` 批量更新或 `updateCoreConfByKey()` 单字段更新。

**项目级配置（ProjectConfig）**：按工作目录分组存储：

```javascript
interface ProjectConfig {
  allowedTools: string[]  // 已持久化的权限（如 'Edit', 'Bash(git status)'）
  history: string[]       // 输入历史（最多 30 条，倒序存储）
  lastEditTime: string    // 最近使用时间
  rules: string[]         // 项目规则
}
```

### 关键方法

```javascript
confManager.setCoreConfig(config)              // 初始化核心配置（设置工作目录、初始化项目配置）
confManager.getCoreConfig()                    // 获取核心配置副本
confManager.updateCoreConfig(partialConfig)    // 批量更新核心配置
confManager.updateCoreConfByKey(key, value)    // 更新单个核心配置字段
confManager.getProjectConfig()                 // 获取当前项目配置副本
confManager.setProjectConfig(partialConfig)    // 更新项目配置并持久化
confManager.saveUserInputToHistory(input)      // 保存用户输入到历史记录
```

### 自动清理规则

- 历史记录：每个项目最多保留 **30 条**输入历史
- 项目数量：全局最多保留 **20 个**项目配置，超过时删除最久未使用的


## ModelManager

**职责**：LLM 模型配置的持久化管理。通过 `getModelManager()` 获取全局单例。

**持久化路径**：`~/.sema/model.conf`

### 数据结构

```javascript
{
  modelProfiles: ModelProfile[]      // 所有已配置模型
  modelPointers: {
    main: string                     // 主任务使用的模型名称
    quick: string                    // 快速任务使用的模型名称
  }
}
```

### 双指针设计

- `main`：用于主 Agent 的完整任务，通常选择能力最强的模型
- `quick`：用于 SubAgent 等快速任务，通常选择响应更快、成本更低的模型

当 AgentConfig 中 `model: 'main'` 时使用 `modelPointers.main` 对应的模型，`model: 'quick'` 时使用 `modelPointers.quick` 对应的模型。

### 关键方法

```javascript
modelManager.addNewModel(config, skipValidation)   // 添加模型（默认进行 API 连接校验）
modelManager.deleteModel(name)                     // 删除模型（被指针引用时禁止删除）
modelManager.switchCurrentModel(name)              // 切换 main 指针指向的模型
modelManager.applyTaskModelConfig(taskConfig)      // 同时设置 main 和 quick 指针
modelManager.getModel(pointer)                     // 获取指定指针的 ModelProfile
modelManager.getModelName(pointer)                 // 获取指定指针的模型名称
modelManager.getModelData()                        // 获取当前模型数据快照
```


## PermissionManager

**职责**：工具执行前的权限检查，以及基于事件的权限请求流程。

详细的权限类型、检查流程和白名单说明参考：[权限系统](wiki/core-concepts/tool-system/permission-system)

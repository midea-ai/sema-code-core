# SemaCore — 公共 API 层

`SemaCore` 是 Sema Core 对外暴露的唯一入口类，采用外观（Facade）模式封装内部复杂度，内部委托给 `SemaEngine` 处理业务逻辑。

## 初始化

```javascript
import { SemaCore } from 'sema-core'

const sema = new SemaCore(config?: SemaCoreConfig)
```

构造函数会异步完成核心配置写入，并触发 `PluginsManager`、`MemoryManager`、`RuleManager` 等单例的后台初始化（市场插件信息、Memory、Rule）。`createSession()` 会等待该初始化完成。

`SemaCoreConfig` 详见 [基础用法](wiki/getting-started/basic-usage/basic-usage)。

## 事件系统

```javascript
// 持续监听
sema.on<T>(event: string, listener: (data: T) => void): SemaCore

// 监听一次后自动移除
sema.once<T>(event: string, listener: (data: T) => void): SemaCore

// 取消监听
sema.off<T>(event: string, listener: (data: T) => void): SemaCore
```

所有方法返回 `SemaCore` 实例，支持链式调用：

```javascript
sema
  .on('message:text:chunk', handleChunk)
  .on('state:update', handleState)
  .on('tool:execution:complete', handleTool)
```

完整事件列表见 [事件类型](wiki/core-concepts/event-system/event-catalog)。

## 响应处理器

AI 执行过程中会通过事件请求用户响应，需调用对应方法回应：

### 工具权限响应

```javascript
sema.respondToToolPermission(response: ToolPermissionResponse): void

interface ToolPermissionResponse {
  toolId: string    // 工具调用唯一 ID（与请求事件中的 toolId 对应）
  toolName: string  // 工具名称
  selected:
    | 'agree'   // 同意本次执行
    | 'allow'   // 同意并记住（写入项目配置）
    | 'refuse'  // 拒绝执行
    | string    // 自定义反馈文本（返回给 LLM 作为提示）
}
```

> `toolId` 用于精确匹配同时存在多个权限请求的场景。

### 提问响应

```javascript
sema.respondToPickOption(response: PickOptionResponseData): void

interface PickOptionResponseData {
  agentId: string                  // 代理 ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  answers: string | null           // 表单答案纯文本；null 表示用户取消整个表单
}
```

### Plan 退出响应

```javascript
sema.respondToPlanExit(response: PlanExitResponseData): void

interface PlanExitResponseData {
  agentId: string
  selected:
    | 'startEditing'          // 切换到 Agent 模式，保留历史
    | 'clearContextAndStart'  // 切换到 Agent 模式，清空历史
}
```

## 会话管理

```javascript
// 创建或恢复会话（异步等待初始化完成）
createSession(sessionId?: string): Promise<void>

// 处理用户输入（非阻塞）
// 处理中收到的输入会按 command/inject 类型自动入队
// /quickchat 旁路问答会绕过状态机直接处理
processUserInput(input: string, originalInput?: string): void

// 中断当前执行（队列中的待处理输入不受影响）
interruptSession(): void
```

> 当处于 `processing` 状态时再次调用 `createSession`，引擎会先中断当前请求并等待旧会话结束（最多 10 秒），再切换到新会话。

## 模型管理

```javascript
// 添加模型（skipValidation=true 跳过 API 连接测试）
addModel(config: ModelConfig, skipValidation?: boolean): Promise<ModelUpdateData>

// 删除模型
delModel(modelName: string): Promise<ModelUpdateData>

// 切换当前主模型
switchModel(modelName: string): Promise<ModelUpdateData>

// 配置 main / quick 双模型指针
applyTaskModel(config: TaskConfig): Promise<ModelUpdateData>

// 获取模型数据快照
getModelData(): Promise<ModelUpdateData>
```

## 工具 API（无会话状态依赖）

```javascript
// 获取提供商可用模型列表
fetchAvailableModels(params: FetchModelsParams): Promise<FetchModelsResult>

// 测试 API 连接
testApiConnection(params: ApiTestParams): Promise<ApiTestResult>

// 解析提供商 + 模型名对应的适配器
getModelAdapter(provider: string, modelName: string)
```

## 配置管理

```javascript
// 更新单个核心配置项
updateCoreConfByKey<K extends UpdatableCoreConfigKeys>(key: K, value: SemaCoreConfig[K]): void

// 批量更新核心配置
updateCoreConfig(config: UpdatableCoreConfig): void

// 过滤可用工具（null 表示恢复全部）
updateUseTools(toolNames: string[] | null): void  // 使用 snake_case 工具名，如 'run_shell', 'view_file'

// 切换 Agent / Plan 模式
updateAgentMode(mode: 'Agent' | 'Plan'): void

// 获取当前所有内置工具信息（含启用状态）
getToolInfos(): ToolInfo[]

// 启用/禁用自动编辑模式
updateAutoEdit(enable: boolean): void
```

> `updateCoreConfByKey` 仅支持以下字段的运行时更新：`stream`、`thinking`、`systemPrompt`、`customRules`、`skipFileEditPermission`、`skipShellExecPermission`、`skipSkillPermission`、`skipMCPToolPermission`、`skipFetchUrlPermission`、`enableLLMCache`、`disableBackgroundTasks`。

## 插件市场管理

```javascript
// 添加 marketplace
addMarketplaceFromGit(repo: string): Promise<MarketplacePluginsInfo>
addMarketplaceFromDirectory(dirPath: string): Promise<MarketplacePluginsInfo>

// 更新 / 移除 marketplace
updateMarketplace(marketplaceName: string): Promise<MarketplacePluginsInfo>
removeMarketplace(marketplaceName: string): Promise<MarketplacePluginsInfo>

// 插件安装 / 卸载（按 user / project 作用域）
installPlugin(pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo>
uninstallPlugin(pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo>

// 启用 / 禁用 / 升级插件
enablePlugin(pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo>
disablePlugin(pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo>
updatePlugin(pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo>

// 获取 / 刷新插件市场信息
getMarketplacePluginsInfo(): Promise<MarketplacePluginsInfo>
refreshMarketplacePluginsInfo(): Promise<MarketplacePluginsInfo>
```

## Agents 管理

```javascript
// 获取所有 Agent 配置；传 refresh=true 强制刷新
getAgentsInfo(concise?: boolean, refresh?: boolean): Promise<AgentConfig[]>

// 增加 / 删除自定义 Agent
addAgentConf(agentConf: AgentConfig): Promise<AgentConfig[]>
removeAgentConf(name: string): Promise<AgentConfig[]>
```

## Skills 管理

```javascript
// 获取所有 Skill 配置；传 refresh=true 强制刷新
getSkillsInfo(concise?: boolean, refresh?: boolean): Promise<SkillConfig[]>

// 删除 Skill 配置
removeSkillConf(name: string): Promise<SkillConfig[]>
```

## Commands 管理

```javascript
// 获取所有自定义命令；传 refresh=true 强制刷新
getCommandsInfo(concise?: boolean, refresh?: boolean): Promise<CommandConfig[]>

// 增加 / 删除自定义命令
addCommandConf(commandConf: CommandConfig): Promise<CommandConfig[]>
removeCommandConf(name: string): Promise<CommandConfig[]>
```

## MCP 管理

```javascript
// 获取 / 刷新所有 MCP 服务器
getMCPServerInfo(): Promise<MCPServerInfo[]>
refreshMCPServerInfo(): Promise<MCPServerInfo[]>

// 增加 / 删除 MCP 服务器
addMCPServer(mcpConfig: MCPServerConfig): Promise<MCPServerInfo[]>
removeMCPServer(name: string): Promise<MCPServerInfo[]>

// 重连 MCP 服务器
reconnectMCPServer(name: string): Promise<MCPServerInfo[]>

// 启用 / 禁用 MCP 服务器
enableMCPServer(name: string): Promise<MCPServerInfo[]>
disableMCPServer(name: string): Promise<MCPServerInfo[]>

// 更新某个 MCP 服务器启用的工具列表
updateMCPUseTools(name: string, toolNames: string[]): Promise<MCPServerInfo[]>
```

## Memory 管理

```javascript
// 获取 Memory 信息；传 refresh=true 强制刷新
getMemoryInfo(refresh?: boolean): Promise<MemoryConfig | null>
```

## Rule 管理

```javascript
// 获取项目规则信息；传 refresh=true 强制刷新
getRuleInfo(refresh?: boolean): Promise<RuleConfig | null>
```

## 后台任务管理

```javascript
// 获取所有后台任务列表（不含前台任务）
getTaskList(): TaskListItem[]

// 订阅指定任务的输出增量，返回取消订阅函数
watchTask(taskId: string, onDelta: (delta: string) => void): () => void

// 停止指定任务
stopTask(taskId: string): boolean

// 停止所有任务
stopAllTasks(): number

// 将运行中的前台 Agent 转为后台执行
transferAgentToBackground(taskId: string): boolean

// 将所有运行中的前台 Agent 批量转为后台执行
transferAllForegroundAgents(): string[]
```

> 后台任务包含 `run_shell` 与 `sub_agent` 两种类型，由 `TaskManager` 统一管理。后台任务完成后会通过内部回调把通知作为 `silent` 输入注入主对话队列。

## 定时任务管理

```javascript
// 获取所有定时任务列表
getCronTasks(): Promise<CronTask[]>

// 删除定时任务
deleteCronTask(id: string): boolean

// 启用定时任务
enableCronTask(id: string): boolean

// 禁用定时任务
disableCronTask(id: string): boolean
```

> 定时任务由 `CronManager` 统一管理，支持一次性任务和循环任务。持久化任务存储在项目目录 `.sema/scheduled_tasks.json` 中。

## 清理

```javascript
// 释放所有资源（后台任务、插件、Memory、Rule、引擎、事件监听器等）
dispose(): Promise<void>
```

# SemaCore — 公共 API 层

`SemaCore` 是 Sema Core 的进程级入口类，采用外观（Facade）模式封装全局资源、配置、模型、插件、MCP、Cron 和会话池。会话内交互由 `SemaSession` 承载。

## 初始化

```javascript
import { SemaCore } from 'sema-core'

const sema = new SemaCore(config?: SemaCoreConfig)
```

构造函数会异步完成核心配置写入，并触发 `PluginsManager`、`MemoryManager`、`RuleManager` 等单例的后台初始化（市场插件信息、Memory、Rule）。首次 `createSession()` 会等待该初始化完成。

`SemaCoreConfig` 详见 [基础用法](wiki/getting-started/basic-usage/basic-usage)。

## 事件系统

`SemaCore` 支持两类事件监听：

- **会话级事件**：由 `SemaSession.on` 提供，绑定到特定会话生命周期
- **进程级事件**：由 `SemaCore.on/once/off` 提供，描述全局资源状态变化（如定时任务更新、MCP 服务器状态变更），与具体会话无关

```javascript
// 持续监听
sema.on<T>(event: ProcessEvent, listener: (data: T) => void): SemaCore

// 监听一次后自动移除
sema.once<T>(event: ProcessEvent, listener: (data: T) => void): SemaCore

// 取消监听
sema.off<T>(event: ProcessEvent, listener: (data: T) => void): SemaCore
```

所有方法返回 `SemaCore` 实例，支持链式调用：

```javascript
sema
  .on('cron:update', handleCronUpdate)
  .on('mcp:server:status', handleMcpStatus)
```

> 进程级事件（如 `cron:update`、`mcp:server:status`）由 `SemaCore.on/once/off` 订阅，生命周期跟随 Core 实例，`dispose()` 时自动摘除。完整事件列表见 [事件类型](wiki/core-concepts/event-system/event-catalog)。

## 会话管理

```javascript
// 创建或恢复会话
createSession(opts?: CreateSessionOptions): Promise<CreateSessionResult>

interface CreateSessionOptions {
  sessionId?: string             // 可选：恢复指定历史会话；不传则新建
  agentMode?: 'Agent' | 'Plan' | 'Design'
}

type CreateSessionResult =
  | { ok: true, session: SemaSession }
  | { ok: false, error: string }

// 查询/切换/关闭会话
getSession(sessionId: string): SemaSession | undefined
listSessions(): string[]
setActiveSession(sessionId: string): boolean
closeSession(sessionId: string): boolean
```

`createSession()` 成功时返回 `SemaSession`，所有会话级能力都在 session 上：

```javascript
const result = await sema.createSession()
if (result.ok) {
  const session = result.session
  session.on('message:text:chunk', handleChunk)
  session.processUserInput('帮我分析这个项目')
}
```

> `maxSessions` 可限制同时存在的会话数量。超过限制时返回 `{ ok: false, error }`，不会抛异常。`setActiveSession()` 主要用于 UI 指定当前打开会话，Cron 等全局通知在来源会话不可用时会投递到活跃会话。

会话级事件、权限响应、用户输入、中断、Agent 模式切换、自动编辑和后台任务 API 见 [SemaSession - 会话级 API](wiki/core-concepts/core-architecture/sema-session-api)。

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

// 解析提供商 + 模型名 + baseURL 对应的适配器
getModelAdapter(provider: string, modelName: string, baseURL: string)
```

## 配置管理

```javascript
// 更新单个核心配置项
updateCoreConfByKey<K extends UpdatableCoreConfigKeys>(key: K, value: SemaCoreConfig[K]): void

// 批量更新核心配置
updateCoreConfig(config: UpdatableCoreConfig): void

// 更新全局禁用工具（黑名单；内部转换为 useTools 白名单）
updateDisabledTools(toolNames: string[] | null): void

// 获取当前所有内置工具信息（含启用状态）
getToolInfos(): ToolInfo[]
```

> `updateCoreConfByKey` 仅支持以下字段的运行时更新：`stream`、`thinking`、`systemPrompt`、`customRules`、`skipFileEditPermission`、`skipShellExecPermission`、`skipSkillPermission`、`skipMCPToolPermission`、`skipFetchUrlPermission`、`enableLLMCache`、`disableBackgroundTasks`。Agent 模式和自动编辑属于会话级配置，请使用 `SemaSession.updateAgentMode()` / `SemaSession.updateAutoEdit()`。

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

## Design 管理

```javascript
// 获取设计技能信息；传 refresh=true 强制刷新
getDesignSkillsInfo(refresh?: boolean): Promise<DesignSkillInfo[]>

// 获取设计系统信息；传 refresh=true 强制刷新
getDesignSystemsInfo(refresh?: boolean): Promise<DesignSystemInfo[]>
```

## 后台任务管理

后台任务包含 `run_shell` 与 `sub_agent` 两种类型，由 `TaskManager` 统一管理，但对外 API 已下沉到 `SemaSession`。每个会话只能看到和停止自己的后台任务，运行中任务限额也按会话独立计算。详见 [SemaSession - 会话级 API](wiki/core-concepts/core-architecture/sema-session-api) 与 [后台任务概述](wiki/core-concepts/task-management/overview)。

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

> 定时任务由 `CronManager` 统一管理，支持一次性任务和循环任务。`persist=true` 的任务存储在项目目录 `.sema/scheduled_tasks.json` 中；禁用状态存储在 `.sema/settings.json` 的 `disabledCronTasks` 中。

## 清理

```javascript
// 释放所有资源（后台任务、插件、Memory、Rule、引擎、进程级事件监听器等）
dispose(): Promise<void>
```

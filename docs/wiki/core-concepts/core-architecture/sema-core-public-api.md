# SemaCore — 公共 API 层

`SemaCore` 是 Sema Code Core 对外暴露的唯一入口类，采用外观（Facade）模式封装内部复杂度。

## 初始化

```javascript
import { SemaCore } from 'sema-core'

const sema = new SemaCore(config: SemaCoreConfig)
```

`SemaCoreConfig` 详见 [基础用法](wiki/getting-started/basic-usage/basic-usage)。## 事件系统

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
  toolName: string
  selected:
    | 'agree'   // 同意本次执行
    | 'allow'   // 同意并记住（写入项目配置）
    | 'refuse'  // 拒绝执行
    | string    // 自定义反馈文本（返回给 LLM 作为提示）
}
```

### 提问响应

```javascript
sema.respondToAskQuestion(response: AskQuestionResponseData): void

interface AskQuestionResponseData {
  answers: Record<string, string>  // {questionId: selectedValue}
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
// 创建或恢复会话
createSession(sessionId?: string): Promise<void>

// 处理用户输入（非阻塞）
processUserInput(input: string, originalInput?: string): void

// 中断当前执行
interruptSession(): void
```

## 模型管理

```javascript
// 添加模型（skipValidation=true 跳过 API 连接测试）
addModel(config: ModelConfig, skipValidation?: boolean): Promise<ModelUpdateData>

// 删除模型
delModel(modelName: string): Promise<ModelUpdateData>

// 切换当前模型
switchModel(modelName: string): Promise<ModelUpdateData>

// 配置主/快速模型指针
applyTaskModel(config: TaskConfig): Promise<ModelUpdateData>

// 获取模型数据
getModelData(): Promise<ModelUpdateData>

// 测试 API 连接
testApiConnection(params: ApiTestParams): Promise<ApiTestResult>

// 获取提供商可用模型列表
fetchAvailableModels(params: FetchModelsParams): Promise<FetchModelsResult>
```

## 配置管理

```javascript
// 更新单个配置项
updateCoreConfByKey<K extends keyof SemaCoreConfig>(key: K, value: SemaCoreConfig[K]): void

// 批量更新配置
updateCoreConfig(config: UpdatableCoreConfig): void

// 过滤可用工具（null 表示恢复全部）
updateUseTools(toolNames: string[] | null): void

// 切换 Agent / Plan 模式
updateAgentMode(mode: 'Agent' | 'Plan'): void

// 获取当前可用工具信息
getToolInfos(): ToolInfo[]
```

## MCP 管理

```javascript
// 添加或更新 MCP 服务器
addOrUpdateMCPServer(config: MCPServerConfig, scope: MCPScopeType): Promise<MCPServerInfo>

// 移除 MCP 服务器
removeMCPServer(name: string, scope: MCPScopeType): Promise<boolean>

// 获取所有 MCP 服务器配置
getMCPServerConfigs(): Map<MCPScopeType, MCPServerInfo[]>

// 重新连接 MCP 服务器
connectMCPServer(name: string): Promise<MCPServerInfo>

// 更新 MCP 服务器的工具过滤
updateMCPUseTools(name: string, toolNames: string[] | null): boolean
```## Skill 管理

```javascript
// 获取所有可用 Skill 信息
getSkillsInfo(): SkillInfo[]
```

## Agent 管理

```javascript
// 获取所有可用 Agent 信息
getAgentsInfo(): AgentInfo[]

// 添加自定义 Agent 配置
addAgentConf(agentConf: AgentConfig): Promise<boolean>
```

## Command 管理

```javascript
// 获取所有自定义命令
getCustomCommands(): Promise<CustomCommand[]>

// 重新加载命令配置
reloadCustomCommands(): void
```

## 清理

```javascript
// 释放所有资源（MCP 连接、子进程等）
dispose(): Promise<void>
```


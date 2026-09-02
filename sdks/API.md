# Sema SDK 多语言 API 对照

各语言 SDK 是 Node 版 sema-core 的镜像客户端，方法名/参数名/事件名与 core 一一对应。下表按**进程级 API**、**会话级 API**、**事件**三部分给出对照，方便跨语言查阅。

## 命名与形态约定

| 维度 | sema-core (Node) | Python | Java | C# |
| --- | --- | --- | --- | --- |
| 方法名 | `camelCase` | `snake_case` | `camelCase` | `PascalCase` |
| 事件订阅 | `on("session:ready", …)`（事件字符串） | 同 Node（裸字符串） | 同 Node（裸字符串） | 同 Node（裸字符串） |
| 返回数据 | 原生类型 | `dict` / `list`（TypedDict 类型化） | 强类型 DTO（同步直接返回，见下方说明） | 强类型 DTO（`Task<T>`） |
| 类型 DTO | `sema-core` / `/types` / `/event` | `sema_core` / `.types` / `.event`（已类型化，详见第四部分） | 已类型化（`semacore.type` / `semacore.event`，详见第四部分） | 已类型化（`Semacore.Types` / `Semacore.Events`，详见第四部分） |

> **异步/同步形态**：Python 协程 / C# `Task` 为异步，调用需 `await`；**Java 为同步阻塞、直接返回结果**——请求方法内部阻塞、直接返回上表「返回数据」的强类型 DTO，不暴露 `CompletableFuture`、无需 `join`（语义等价于其它语言的 `await` 行）；各语言中 Node 侧 `void` 的方法仍无返回。⚠️ Java 会阻塞的方法不要在事件回调线程里调用（会死锁）。`sema-core` 列以 `await` 前缀标注该方法在 Node 侧即为异步；未加前缀表示 Node 侧同步。跨语言经 gRPC 桥调用必为一次往返，故「Node 同步 / SDK 跨进程」这一差异不在「差异点备注」逐条重复——备注仅记录方法名/参数名/返回值/行为上的真实差异，无则记 `—`。参数中必填项标注 `(必填)`，无参数记为 `—`。

> 类型 DTO 的导入布局对照见**第四部分「类型与导入」**。

---

## 一、进程级 API（SemaCore）

### 生命周期

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `new SemaCore(config)` | `SemaCore.start` | `SemaCore.start` | `SemaCore.Start` | `config: SemaCoreConfig` | Node 直接 new；SDK 用静态 `start()` 托管 sidecar |
| `await dispose()` | `close` | `close` | `Close` | — | SDK 统一叫 `close`；托管实例 close 时级联杀桥 |

### 会话池

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await createSession` | `create_session` | `createSession` | `CreateSession` | `opts: CreateSessionOptions` | `opts` 含 `sessionId?/agentMode?/permissionLevel?/mainModel?/quickModel?`；`mainModel`/`quickModel` 为会话级模型覆盖（profile 名，同 switchModel 参数），仅本会话生效、不持久化 |
| `getSession` | `session` / `get_session` | `session` / `getSession` | `Session` / `GetSession` | `sessionId: string`(必填) | core 查池、无则 `undefined`；SDK 只造句柄、恒有返回，用时才校验存在 |
| `listSessions` | `list_sessions` | `listSessions` | `ListSessions` | — | — |
| `setActiveSession` | `set_active_session` | `setActiveSession` | `SetActiveSession` | `sessionId: string`(必填) | — |
| `closeSession` | `close_session` | `closeSession` | `CloseSession` | `sessionId: string`(必填) | — |
| `deleteSessionHistory` | `delete_session_history` | `deleteSessionHistory` | `DeleteSessionHistory` | `sessionId: string`(必填), `projectPath: string` | 删除单个会话的 core 落盘历史文件（宿主删历史条目后同步清理）；`projectPath` 缺省回落到 core 的 `workingDir`，仍为空则跳过不操作（不碰全局目录） |
| `deleteProjectHistory` | `delete_project_history` | `deleteProjectHistory` | `DeleteProjectHistory` | `projectPath: string` | 删除指定项目的全部历史与快照目录；`projectPath` 缺省回落到 core 的 `workingDir`，仍为空则跳过不操作 |

### 进程级事件

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `on` | `on` | `on` | `On` | `event: ProcessEvent`(必填), `listener: (data) => void`(必填) | — |
| `once` | `once` | `once` | `Once` | `event: ProcessEvent`(必填), `listener: (data) => void`(必填) | — |
| `off` | `off` | `off` | `Off` | `event: ProcessEvent`(必填), `listener: (data) => void`(必填) | 也可用 `on`/`once` 返回的 `Registration.unregister()` |

### 模型管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await addModel` | `add_model` | `addModel` | `AddModel` | `config: ModelConfig`(必填), `skipValidation: boolean` | — |
| `await delModel` | `del_model` | `delModel` | `DelModel` | `modelName: string`(必填) | — |
| `await switchModel` | `switch_model` | `switchModel` | `SwitchModel` | `modelName: string`(必填) | — |
| `await applyTaskModel` | `apply_task_model` | `applyTaskModel` | `ApplyTaskModel` | `config: TaskConfig`(必填) | — |
| `await getModelData` | `get_model_data` | `getModelData` | `GetModelData` | — | — |

### 配置管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `updateCoreConfig` | `update_core_config` | `updateCoreConfig` | `UpdateCoreConfig` | `config: UpdatableCoreConfig`(必填) | — |
| `updateCoreConfByKey` | `update_core_conf_by_key` | `updateCoreConfByKey` | `UpdateCoreConfByKey` | `key: UpdatableCoreConfigKeys`(必填), `value: SemaCoreConfig[K]`(必填) | — |
| `updateDisabledTools` | `update_disabled_tools` | `updateDisabledTools` | `UpdateDisabledTools` | `toolNames: string[] | null`(必填) | — |
| `getToolInfos` | `get_tool_infos` | `getToolInfos` | `GetToolInfos` | — | — |

### 工具 API

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await fetchAvailableModels` | `fetch_available_models` | `fetchAvailableModels` | `FetchAvailableModels` | `params: FetchModelsParams`(必填) | — |
| `await testApiConnection` | `test_api_connection` | `testApiConnection` | `TestApiConnection` | `params: ApiTestParams`(必填) | — |
| `getModelAdapter` | `get_model_adapter` | `getModelAdapter` | `GetModelAdapter` | `provider: string`(必填), `modelName: string`(必填), `baseURL: string`(必填) | — |

### 插件市场管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getMarketplacePluginsInfo` | `get_marketplace_plugins_info` | `getMarketplacePluginsInfo` | `GetMarketplacePluginsInfo` | — | — |
| `await refreshMarketplacePluginsInfo` | `refresh_marketplace_plugins_info` | `refreshMarketplacePluginsInfo` | `RefreshMarketplacePluginsInfo` | — | — |
| `await addMarketplaceFromGit` | `add_marketplace_from_git` | `addMarketplaceFromGit` | `AddMarketplaceFromGit` | `repo: string`(必填) | — |
| `await addMarketplaceFromDirectory` | `add_marketplace_from_directory` | `addMarketplaceFromDirectory` | `AddMarketplaceFromDirectory` | `dirPath: string`(必填) | — |
| `await updateMarketplace` | `update_marketplace` | `updateMarketplace` | `UpdateMarketplace` | `marketplaceName: string`(必填) | — |
| `await removeMarketplace` | `remove_marketplace` | `removeMarketplace` | `RemoveMarketplace` | `marketplaceName: string`(必填) | — |
| `await installPlugin` | `install_plugin` | `installPlugin` | `InstallPlugin` | `pluginName: string`(必填), `marketplaceName: string`(必填), `scope: PluginScopeKind`(必填), `projectPath: string` | — |
| `await uninstallPlugin` | `uninstall_plugin` | `uninstallPlugin` | `UninstallPlugin` | `pluginName: string`(必填), `marketplaceName: string`(必填), `scope: PluginScopeKind`(必填), `projectPath: string` | — |
| `await enablePlugin` | `enable_plugin` | `enablePlugin` | `EnablePlugin` | `pluginName: string`(必填), `marketplaceName: string`(必填), `scope: PluginScopeKind`(必填), `projectPath: string` | — |
| `await disablePlugin` | `disable_plugin` | `disablePlugin` | `DisablePlugin` | `pluginName: string`(必填), `marketplaceName: string`(必填), `scope: PluginScopeKind`(必填), `projectPath: string` | — |
| `await updatePlugin` | `update_plugin` | `updatePlugin` | `UpdatePlugin` | `pluginName: string`(必填), `marketplaceName: string`(必填), `scope: PluginScopeKind`(必填), `projectPath: string` | — |

### Agents 管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getAgentsInfo` | `get_agents_info` | `getAgentsInfo` | `GetAgentsInfo` | `concise: boolean`, `refresh: boolean` | — |
| `await addAgentConf` | `add_agent_conf` | `addAgentConf` | `AddAgentConf` | `agentConf: AgentConfig`(必填) | — |
| `await removeAgentConf` | `remove_agent_conf` | `removeAgentConf` | `RemoveAgentConf` | `name`(必填) | — |

### Skills 管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getSkillsInfo` | `get_skills_info` | `getSkillsInfo` | `GetSkillsInfo` | `concise: boolean`, `refresh: boolean` | 返回含禁用项，`status: false` 表示已禁用 |
| `await removeSkillConf` | `remove_skill_conf` | `removeSkillConf` | `RemoveSkillConf` | `name`(必填) | — |
| `await enableSkill` | `enable_skill` | `enableSkill` | `EnableSkill` | `name`(必填) | 写入层跟随技能所在层（用户级技能全局生效） |
| `await disableSkill` | `disable_skill` | `disableSkill` | `DisableSkill` | `name`(必填) | 写入 settings 的 `disabledSkills`（用户级+项目级并集生效） |

### Commands 管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getCommandsInfo` | `get_commands_info` | `getCommandsInfo` | `GetCommandsInfo` | `concise: boolean`, `refresh: boolean` | — |
| `await addCommandConf` | `add_command_conf` | `addCommandConf` | `AddCommandConf` | `commandConf: CommandConfig`(必填) | — |
| `await removeCommandConf` | `remove_command_conf` | `removeCommandConf` | `RemoveCommandConf` | `name`(必填) | — |

### MCP 管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getMCPServerInfo` | `get_mcp_server_info` | `getMCPServerInfo` | `GetMCPServerInfo` | — | — |
| `await refreshMCPServerInfo` | `refresh_mcp_server_info` | `refreshMCPServerInfo` | `RefreshMCPServerInfo` | — | — |
| `await addMCPServer` | `add_mcp_server` | `addMCPServer` | `AddMCPServer` | `mcpConfig: MCPServerConfig`(必填) | — |
| `await removeMCPServer` | `remove_mcp_server` | `removeMCPServer` | `RemoveMCPServer` | `name`(必填) | — |
| `await reconnectMCPServer` | `reconnect_mcp_server` | `reconnectMCPServer` | `ReconnectMCPServer` | `name`(必填) | — |
| `await disableMCPServer` | `disable_mcp_server` | `disableMCPServer` | `DisableMCPServer` | `name`(必填) | 写入 settings 的 `disabledMcpServers`（用户级+项目级并集生效），写入层跟随 server 所在层 |
| `await enableMCPServer` | `enable_mcp_server` | `enableMCPServer` | `EnableMCPServer` | `name`(必填) | 只从 server 所在层移除禁用记录；另一层仍禁用时不会连接 |
| `await updateMCPUseTools` | `update_mcp_use_tools` | `updateMCPUseTools` | `UpdateMCPUseTools` | `name`(必填), `toolNames: string[] \| null`(必填，null=全部可用) | 写入 settings 的 `enabledMcpServerUseTools`（用户级打底、项目级同名覆盖），写入层跟随 server 所在层 |

### Memory 管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getMemoryInfo` | `get_memory_info` | `getMemoryInfo` | `GetMemoryInfo` | `refresh: boolean` | — |

### Rule 管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getRuleInfo` | `get_rule_info` | `getRuleInfo` | `GetRuleInfo` | `refresh: boolean` | — |

### Hooks 管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getHooksInfo` | `get_hooks_info` | `getHooksInfo` | `GetHooksInfo` | `refresh: boolean` | 返回合并后的 hooks 配置视图 `HooksInfo`；`refresh=true` 重新加载配置 |

### Cron 定时任务管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getCronTasks` | `get_cron_tasks` | `getCronTasks` | `GetCronTasks` | — | — |
| `deleteCronTask` | `delete_cron_task` | `deleteCronTask` | `DeleteCronTask` | `id: string`(必填) | — |
| `enableCronTask` | `enable_cron_task` | `enableCronTask` | `EnableCronTask` | `id: string`(必填) | — |
| `disableCronTask` | `disable_cron_task` | `disableCronTask` | `DisableCronTask` | `id: string`(必填) | — |

### Design 设计资源

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `await getDesignSkillsInfo` | `get_design_skills_info` | `getDesignSkillsInfo` | `GetDesignSkillsInfo` | `refresh: boolean` | — |
| `await getDesignSystemsInfo` | `get_design_systems_info` | `getDesignSystemsInfo` | `GetDesignSystemsInfo` | `refresh: boolean` | — |

---

## 二、会话级 API（SemaSession）

### 事件与交互应答

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `on` | `on` | `on` | `On` | `event: string`(必填), `listener: (data) => void`(必填) | — |
| `once` | `once` | `once` | `Once` | `event: string`(必填), `listener: (data) => void`(必填) | — |
| `off` | `off` | `off` | `Off` | `event: string`(必填), `listener: (data) => void`(必填) | 也可用 `on`/`once` 返回的 `Registration.unregister()` |
| — | `wait_for` | `waitFor` | `WaitFor` | `event: string`(必填), `timeout: number`, `predicate: (data) => boolean` | SDK 独有：`once` 的 `await` 封装（加超时 / `predicate` 过滤）；core 事件驱动无此需求 |
| `respondToToolPermission` | `respond_to_tool_permission` | `respondToToolPermission` | `RespondToToolPermission` | `response: ToolPermissionResponse`(必填) | — |
| `respondToPickOption` | `respond_to_pick_option` | `respondToPickOption` | `RespondToPickOption` | `response: PickOptionResponseData`(必填) | — |
| `respondToPlanExit` | `respond_to_plan_exit` | `respondToPlanExit` | `RespondToPlanExit` | `response: PlanExitResponseData`(必填) | — |

### 会话交互

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `processUserInput` | `process_user_input` | `processUserInput` | `ProcessUserInput` | `input: string`(必填), `originalInput: string`, `attachments: InputImageAttachment[]` | — |
| `interrupt` | `interrupt` | `interrupt` | `Interrupt` | — | — |

### 会话级配置

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `updateAgentMode` | `update_agent_mode` | `updateAgentMode` | `UpdateAgentMode` | `mode: AgentMode`(必填) | — |
| `updatePermissionLevel` | `update_permission_level` | `updatePermissionLevel` | `UpdatePermissionLevel` | `level: PermissionLevel`(必填) | — |

### 会话 Fork / 撤销

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `getForkPreview` | `get_fork_preview` | `getForkPreview` | `GetForkPreview` | `messageUuid: string`(必填) | — |
| `await fork` | `fork` | `fork` | `Fork` | `messageUuid: string`(必填), `options: ForkOptions` | — |
| `await branch` | `branch` | `branch` | `Branch` | `beforeMessageUuid: string` | 分支到新聊天：复制截断历史到新会话（源会话与工作区不动），返回 `BranchResult`（含新 sessionId）；锚点缺省则全量复制 |

### 后台任务（仅本会话）

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `getTaskList` | `get_task_list` | `getTaskList` | `GetTaskList` | — | — |
| `watchTask` | `watch_task` | `watchTask` | `WatchTask` | `taskId: string`(必填), `onDelta: (delta) => void`(必填) | — |
| `stopTask` | `stop_task` | `stopTask` | `StopTask` | `taskId: string`(必填) | — |
| `stopAllTasks` | `stop_all_tasks` | `stopAllTasks` | `StopAllTasks` | — | — |
| `transferAgentToBackground` | `transfer_agent_to_background` | `transferAgentToBackground` | `TransferAgentToBackground` | `taskId: string`(必填) | — |
| `transferAllForegroundAgents` | `transfer_all_foreground_agents` | `transferAllForegroundAgents` | `TransferAllForegroundAgents` | — | — |

### 资源管理

| sema-core | Python | Java | C# | 参数 | 差异点备注 |
| --- | --- | --- | --- | --- | --- |
| `dispose` | `close` | `close` | `Close` | — | SDK 统一用 `close` |

---

## 三、事件（Events）

事件名跨语言完全一致，各端都用同一个**事件字符串**订阅（如 `session.on("plan:implement", ...)`），与 Node 写法一致——SDK 不提供事件名常量。各事件的数据结构类型见第四部分 4.4（Python 已类型化）。

### 会话级事件

| 事件名 | 数据（参数） | 说明 |
| --- | --- | --- |
| `session:ready` | `SessionReadyData` | 会话初始化完成；SDK 缓存重放，晚订阅也不丢 |
| `session:error` | `SessionErrorData` | 会话出错（api / fatal / 上下文超限 / model_error） |
| `session:interrupted` | `SessionInterruptedData` | 会话被中断（如用户取消） |
| `session:cleared` | `SessionClearedData` | 会话历史被清空 |
| `state:update` | `StateUpdateData` | `idle` / `processing` |
| `input:received` | `InputReceivedData` | 收到用户输入（处理中则入队等待）；`source` 标记来源（缺省 `user`，`cron`=定时任务自动发送） |
| `input:processing` | `InputProcessingData` | 开始处理该用户输入；`source` 含义同上 |
| `input:predict` | `InputPredictData` | 用户输入预测结果（需 `enableInputPrediction` 开启；`prediction` 空串表示预计不回复，UI 应清空提示） |
| `message:text:chunk` | `TextChunkData` | 回复文本流式增量 |
| `message:thinking:chunk` | `ThinkingChunkData` | 思考内容流式增量 |
| `message:complete` | `MessageCompleteData` | 一条 AI 消息完成（完整内容 + 工具调用） |
| `tool:permission:request` | `ToolPermissionRequestData` | 需 `respondToToolPermission` 应答 |
| `tool:permission:auto` | `ToolPermissionAutoData` | AutoRun 档模型自动放行 |
| `tool:execution:complete` | `ToolExecutionCompleteData` | 工具执行完成（含结果） |
| `tool:execution:chunk` | `ToolExecutionChunkData` | 命令执行中间态（`content` 只传 delta） |
| `tool:execution:error` | `ToolExecutionErrorData` | 工具执行出错 |
| `task:agent:start` | `TaskAgentStartData` | 子 agent 开始 |
| `task:agent:end` | `TaskAgentEndData` | 子 agent 结束 |
| `task:start` | `TaskStartData` | 后台任务开始 |
| `task:end` | `TaskEndData` | 后台任务结束 |
| `task:transfer` | `TaskTransferData` | 前台转后台 |
| `todos:update` | `TodosUpdateData` | 待办列表更新（Task 工具执行后） |
| `topic:update` | `TopicUpdateData` | 会话话题标题更新 |
| `pick:option:request` | `PickOptionRequestData` | 需 `respondToPickOption` 应答 |
| `plan:exit:request` | `PlanExitRequestData` | 需 `respondToPlanExit` 应答 |
| `plan:implement` | `PlanImplementData` | 进入计划实施（选「清理上下文并开始编辑」时触发） |
| `compact:exec` | `CompactExecData` | 上下文压缩统计 |
| `compact:micro` | `CompactMicroData` | Micro 压缩统计（旧工具结果替换为占位符；历史未被摘要替换，UI 不应据此隐藏 transcript） |
| `conversation:usage` | `ConversationUsageData` | token 用量 |
| `file:reference` | `FileReferenceData` | 文件/目录引用解析结果 |
| `permissionLevel:update` | `PermissionLevelUpdateData` | 权限档位变更（Ask / AutoEdit / AutoRun / Bypass） |
| `quickchat:response` | `quickchatResponseData` | 旁路问答，不影响主对话 |
| `hook:notice` | `HookNoticeData` | hook 提示（`kind`: `systemMessage` 展示 / `warning` 告警 / `blocked` 输入被拦截），展示给用户、不进模型上下文 |

### 进程级事件

通过 `SemaCore.on` 订阅（不绑定 sessionId）。

| 事件名 | 数据（参数） | 说明 |
| --- | --- | --- |
| `cron:update` | `CronUpdateData` | 定时任务列表变化 |
| `mcp:server:status` | `MCPServerStatusData` | MCP server 状态变更 |

### 桥合成事件（SDK 专有）

core 无此事件，由 gRPC 桥合成，仅在 SDK 侧存在。

| 事件名 | 数据（参数） | 说明 |
| --- | --- | --- |
| `model:update` | 模型数据 | 模型变更跨连接广播（进程级） |
| `task:watch:delta` | `{taskId, delta}` | `watchTask` 流式输出，内部使用 |

---

## 四、类型与导入

core 从三个入口导出类型：`sema-core`（主 API + 常用类型）、`sema-core/types`（配置/参数/返回）、`sema-core/event`（事件数据）。各语言 SDK 提供对应入口，**类型名跨语言完全一致**（均 PascalCase、与 core 同名——不像方法名要按语言转写），差异只在导入语法；字段名亦保持 wire 上的 camelCase（C# 属性 PascalCase + `[JsonPropertyName]` 锚定 wire 名）。**Python / Java / C# 均已实现**。

### 4.1 导入写法（各语言入口）

| 入口 | Node | Python | Java | C# |
| --- | --- | --- | --- | --- |
| 主 API | `import { SemaCore } from 'sema-core'` | `from sema_core import SemaCore` | `import semacore.*;` | `using Semacore;` |
| 类型 | `import { ModelConfig } from 'sema-core/types'` | `from sema_core.types import ModelConfig` | `import semacore.type.*;` | `using Semacore.Types;` |
| 事件 | `import { TextChunkData } from 'sema-core/event'` | `from sema_core.event import TextChunkData` | `import semacore.event.*;` | `using Semacore.Events;` |

> 各入口都带 `core`、无 `com`/`github`/`sdk`。连字符仅 Node 合法；Python 用下划线 `sema_core`，Java 包名/C# 命名空间不允许连字符故写作 `semacore` / `Semacore`（`from sema-core` / `import sema-core` 在这两处均非法；C# 命名空间取品牌词一体化 PascalCase `Semacore`，避免与主类 `SemaCore` 同名冲突——`using SemaCore;` 后 `SemaCore.Start(...)` 会被解析成命名空间成员查找而编译失败）。
>
> 事件订阅用裸事件字符串（如 `"message:text:chunk"`），与 Node 一致，各 SDK 不提供事件名常量。

下面各入口的符号清单（子部分不再重复导入语句，按上表）。

### 4.2 主入口 `sema-core`

```
SemaCore, SemaSession                                        // 主类：进程级 / 会话级
```

### 4.3 类型 `sema-core/types`

```
AgentMode, PermissionLevel, SystemPromptMode                 // Agent 模式 / 权限档位 / 系统提示词模式
SemaCoreConfig, UpdatableCoreConfig, UpdatableCoreConfigKeys // Core 配置 / 可更新子集 / 可更新键名
ModelConfig, TaskConfig, ModelInfo, ModelUpdateData          // 模型：配置 / 主快指针 / 模型项 / 变更结果
FetchModelsParams, FetchModelsResult                         // 拉取可用模型：参数 / 结果
ApiTestParams, ApiTestResult                                 // API 连通测试：参数 / 结果
ToolInfo, FileReferenceInfo                                  // 工具信息 / 文件引用
AgentConfig, AgentScope                                      // Agents：配置 / 作用域
SkillConfig, SkillScope                                      // Skills：配置（含 status 启用态）/ 作用域
CommandConfig, CommandScope                                  // Commands：配置 / 作用域
MCPServerConfig, MCPServerInfo                               // MCP：配置 / 运行信息
MemoryConfig, RuleConfig, RuleScope                          // Memory / Rule（含作用域）
DesignSkillInfo, DesignSystemInfo, DesignSystemColor         // Design：技能 / 系统 / 色板项
PluginScopeKind, MarketplacePluginsInfo                      // 插件市场：作用域 / 汇总信息
CronTask, CronTaskFile                                       // Cron：任务 / 持久化文件
TaskListItem                                                 // 后台任务列表项
TodoItem, TodoTask, TodoTaskStatus                           // 待办：精简项 / 完整任务 / 状态
CreateSessionOptions, CreateSessionResult                    // 会话创建：选项 / 结果
ForkOptions, ForkPreview, ForkResult, ForkFileChange, ForkFileEffect  // 会话 Fork/撤销：选项/预览/结果/文件改动/改动类型
InputImageAttachment                                         // 图片附件（processUserInput）
MAIN_AGENT_ID                                                // 常量：主代理 agentId
```

> `Fork*` 与 `InputImageAttachment` 归 `types` 入口（Python 已如此；Node 侧 `index.ts` 待同步——原在主入口导出）。
>
> `defaultCoreConfig`（含超大默认 systemPrompt）与 `TOOL_NAME_*` 常量暂未纳入 SDK，如需再议。
>
> `systemPromptMode`：`'append'`（默认，配置的 systemPrompt 叠加在内置提示词前）| `'replace'`（替换内置系统提示词，memory/env 上下文仍附加）| `'replaceAll'`（完全替换，系统提示词仅为 systemPrompt，不附加 memory/env/gitStatus，turn-level reminder 也不注入 MEMORY.md）；replace/replaceAll 未配 systemPrompt 时回落 append。仅构造时生效，不支持动态更新。

### 4.4 事件数据 `sema-core/event`

```
SessionReadyData, SessionInterruptedData, SessionErrorData, SessionClearedData  // 会话：就绪/中断/错误/清空
AppSessionState, StateUpdateData                             // 运行状态：状态枚举 / 更新事件
InputReceivedData, InputProcessingData, InputPredictData     // 用户输入：已接收 / 开始处理 / 下一句预测
ThinkingChunkData, TextChunkData, MessageCompleteData        // AI 消息：思考增量 / 文本增量 / 完成
ToolPermissionRequestData, ToolPermissionAutoData, ToolPermissionResponse  // 工具权限：请求 / 自动放行 / 应答
ToolExecutionCompleteData, ToolExecutionChunkData, ToolExecutionErrorData   // 工具执行：完成 / 中间态 / 错误
TodosUpdateData, PermissionLevelUpdateData, TopicUpdateData  // 待办更新 / 档位更新 / 主题更新
Usage, ConversationUsageData, CompactExecData, CompactMicroData  // 用量 / 对话用量 / 压缩统计 / micro 压缩统计
FileReferenceData                                           // 文件引用
PickOptionQuestion, PickOptionRequestData, PickOptionResponseData  // 问答：题型(判别联合) / 请求 / 应答
PlanExitRequestData, PlanExitResponseData, PlanImplementData       // Plan 模式：退出请求 / 应答 / 实施
TaskAgentStartData, TaskAgentEndData                        // 子代理：开始 / 结束
CronTaskStatus, TaskStartData, TaskEndData, TaskTransferData // 后台任务：状态 / 开始 / 结束 / 转后台
quickchatResponseData                                       // quickchat 旁路问答
CronUpdateData, MCPServerStatusData                         // 进程级事件数据：cron 变更 / MCP 状态
ProcessEvent                                                // 进程级事件名联合
```

> `EventListener` / `EventBusInterface`（core 的 JS 事件总线接口）不镜像——各 SDK 有各自的 `on`/`once`/`wait_for` 订阅模型。判别联合 `PickOptionQuestion` 建 tagged 层级（Python `Union` + `Literal`，Java sealed 层级，C# 多态 record）。

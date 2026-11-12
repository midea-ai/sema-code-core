// ≙ 'sema-core/types' 入口（单文件聚合，≙ Python types.py）。由 sdks/shared 契约镜像生成；
// wire 字段名 = camelCase（JsonPropertyName 标注），与 sema-core / Python / Java SDK 完全一致。
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Semacore.Types;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AdapterType { openai, anthropic }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ThinkingHistoryPolicy { preserve, current_turn, omit }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AgentMode { Agent, Plan, Design }

/// <summary>host：宿主构造时传入（内联或 dirs 目录），只读。</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AgentScope { host, user, project, builtin, plugin }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AppSessionState { idle, processing }

/// <summary>host：宿主构造时传入（内联或 dirs 目录），只读。</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CommandScope { host, user, project, plugin }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CronTaskStatus { running, completed, failed, killed }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ForkFileEffect { modify, recreate, delete }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum HookEntryStatus { ok, skipped, invalid }

/// <summary>host：宿主构造时传入，只读、无配置文件。</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum HookScope { host, user, project, plugin }

/// <summary>host：宿主构造时传入的条目（只读，env / headers 对外打码）。</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum MCPScopeType { host, local, project, user, plugin }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum MCPServerStatus { disconnected, connecting, connected, error }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum MCPTransportType { stdio, sse, http }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum PermissionLevel { Ask, AutoEdit, AutoRun, Bypass }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum PluginScopeKind { local, project, user }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum RuleScope { user, project }

/// <summary>host：宿主构造时传入（内联或 dirs 目录），只读。</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SkillScope { host, user, project, plugin, builtin }

/// <summary>
/// 稳定错误码（≙ core SemaErrorCode）：桥 error 帧的 code，挂在 SemaBridgeException.Code 上；文案随 lang 变化而 code 不变。
/// CONFIG_INVALID=构造参数或运行期更新的配置校验不通过；SCOPE_DISABLED=要写的域没有生效；HOST_READONLY=要改的是宿主传入的 host 域条目；
/// HISTORY_KEY_REQUIRED=历史文件是密文但没传密钥；HISTORY_DECRYPT_FAILED=密钥不对或密文损坏。
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SemaErrorCode { CONFIG_INVALID, SCOPE_DISABLED, HOST_READONLY, HISTORY_KEY_REQUIRED, HISTORY_DECRYPT_FAILED }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SystemPromptMode { append, replace, replaceAll }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TodoTaskStatus { pending, in_progress, completed }

/// <summary>长期目标状态（≙ core GoalStatus）：running=自主循环中；paused=用户暂停/中断、系统止损、重开会话，可 resume；completed/blocked=模型自报，blocked 可 resume。</summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum GoalStatus { running, paused, completed, blocked }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ToolStatus { enable, disable }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum UpdatableCoreConfigKeys { lang, stream, thinking, systemPrompt, customRules, skipFileEditPermission, skipShellExecPermission, skipSkillPermission, skipMCPToolPermission, skipFetchUrlPermission, fetchUrlBrowserUserAgent, skipExternalFileReadPermission, disableBackgroundTasks, enableToolSearch, enableInputPrediction, disableLLMLog, disableEventLog }

/// <summary>判别联合（≙ core CreateSessionResult）：按 <c>Ok</c> 分派到 CreateSessionResultOk / CreateSessionResultErr。</summary>
public abstract record CreateSessionResult
{
    [JsonPropertyName("ok")] public bool Ok { get; init; }
}

/// <summary>判别联合（≙ core ForkResult）：按 <c>Ok</c> 分派到 ForkResultOk / ForkResultErr。</summary>
public abstract record ForkResult
{
    [JsonPropertyName("ok")] public bool Ok { get; init; }
}

/// <summary>判别联合（≙ core BranchResult）：按 <c>Ok</c> 分派到 BranchResultOk / BranchResultErr。</summary>
public abstract record BranchResult
{
    [JsonPropertyName("ok")] public bool Ok { get; init; }
}

public record AgentConfig
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("tools")] public JsonElement? Tools { get; init; }
    [JsonPropertyName("model")] public string? Model { get; init; }
    /// <summary>内联（Private）子代理在查询接口里为空串。</summary>
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("locate")] public AgentScope? Locate { get; init; }
    /// <summary>内联子代理没有。</summary>
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    /// <summary>宿主内联传入：正文只在内存里，查询接口不回传。</summary>
    [JsonPropertyName("private")] public bool? Private { get; init; }
}

public record ApiTestParams
{
    [JsonPropertyName("baseURL")] public string? BaseURL { get; init; }
    [JsonPropertyName("apiKey")] public string? ApiKey { get; init; }
    [JsonPropertyName("modelName")] public string? ModelName { get; init; }
    [JsonPropertyName("adapt")] public AdapterType? Adapt { get; init; }
    [JsonPropertyName("provider")] public string? Provider { get; init; }
}

public record ApiTestResult
{
    [JsonPropertyName("success")] public bool Success { get; init; }
    [JsonPropertyName("message")] public string? Message { get; init; }
    [JsonPropertyName("curlCommand")] public string? CurlCommand { get; init; }
}

public record CommandConfig
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    /// <summary>内联（Private）命令在查询接口里为空串。</summary>
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("argumentHint")] public JsonElement? ArgumentHint { get; init; }
    [JsonPropertyName("locate")] public CommandScope? Locate { get; init; }
    /// <summary>内联命令没有。</summary>
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    /// <summary>宿主内联传入：正文只在内存里，查询接口不回传。</summary>
    [JsonPropertyName("private")] public bool? Private { get; init; }
}

public record CreateSessionOptions
{
    [JsonPropertyName("sessionId")] public string? SessionId { get; init; }
    [JsonPropertyName("agentMode")] public AgentMode? AgentMode { get; init; }
    [JsonPropertyName("permissionLevel")] public PermissionLevel? PermissionLevel { get; init; }
    /// <summary>会话级主要模型（profile 名，同 SwitchModel 参数），仅本会话生效、不持久化；null 沿用全局配置。</summary>
    [JsonPropertyName("mainModel")] public string? MainModel { get; init; }
    /// <summary>会话级快速模型，语义同 MainModel。</summary>
    [JsonPropertyName("quickModel")] public string? QuickModel { get; init; }
}

/// <summary>注意 SDK 的 CreateSession 直接返回 SemaSession，失败抛 SemaBridgeException（Code 在 .Code 上）。</summary>
public record CreateSessionResultErr : CreateSessionResult
{
    [JsonPropertyName("error")] public string? Error { get; init; }
    /// <summary>稳定错误码（如历史密文解不开的 HISTORY_DECRYPT_FAILED）；没有对应错误码时为 null。</summary>
    [JsonPropertyName("code")] public SemaErrorCode? Code { get; init; }
}

public record CreateSessionResultOk : CreateSessionResult
{
    [JsonPropertyName("session")] public JsonElement? Session { get; init; }
}

public record CronTask
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("schedule")] public string? Schedule { get; init; }
    [JsonPropertyName("task")] public string? Task { get; init; }
    /// <summary>短标题（创建时生成，≤30 字符）；旧任务可能为 null，UI 回退显示任务 id</summary>
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("repeat")] public bool Repeat { get; init; }
    [JsonPropertyName("persist")] public bool Persist { get; init; }
    [JsonPropertyName("status")] public bool Status { get; init; }
    [JsonPropertyName("createdAt")] public long CreatedAt { get; init; }
    [JsonPropertyName("describeCronExpression")] public string? DescribeCronExpression { get; init; }
    [JsonPropertyName("activatedAt")] public long ActivatedAt { get; init; }
    [JsonPropertyName("nextFireAt")] public List<long>? NextFireAt { get; init; }
    [JsonPropertyName("sessionId")] public string? SessionId { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    [JsonPropertyName("lastFiredAt")] public long? LastFiredAt { get; init; }
}

public record CronTaskFile
{
    [JsonPropertyName("tasks")] public List<CronTaskFileEntry>? Tasks { get; init; }
}

public record CronTaskFileEntry
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("schedule")] public string? Schedule { get; init; }
    [JsonPropertyName("task")] public string? Task { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("repeat")] public bool Repeat { get; init; }
    [JsonPropertyName("createdAt")] public long CreatedAt { get; init; }
    [JsonPropertyName("lastFiredAt")] public long? LastFiredAt { get; init; }
}

public record DesignSkillInfo
{
    [JsonPropertyName("folderName")] public string? FolderName { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
}

public record DesignSystemColor
{
    [JsonPropertyName("key")] public string? Key { get; init; }
    [JsonPropertyName("value")] public string? Value { get; init; }
}

public record DesignSystemInfo
{
    [JsonPropertyName("folderName")] public string? FolderName { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("swatches")] public List<DesignSystemColor>? Swatches { get; init; }
    [JsonPropertyName("colors")] public List<DesignSystemColor>? Colors { get; init; }
}

public record FetchModelsParams
{
    [JsonPropertyName("baseURL")] public string? BaseURL { get; init; }
    [JsonPropertyName("apiKey")] public string? ApiKey { get; init; }
    [JsonPropertyName("adapt")] public AdapterType? Adapt { get; init; }
    [JsonPropertyName("provider")] public string? Provider { get; init; }
    [JsonPropertyName("modelsUrl")] public string? ModelsUrl { get; init; }
}

public record FetchModelsResult
{
    [JsonPropertyName("success")] public bool Success { get; init; }
    [JsonPropertyName("models")] public List<ModelInfo>? Models { get; init; }
    [JsonPropertyName("message")] public string? Message { get; init; }
    [JsonPropertyName("curlCommand")] public string? CurlCommand { get; init; }
}

public record FileReferenceInfo
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("content")] public string? Content { get; init; }
}

public record ForkFileChange
{
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    [JsonPropertyName("displayPath")] public string? DisplayPath { get; init; }
    [JsonPropertyName("effect")] public ForkFileEffect? Effect { get; init; }
    [JsonPropertyName("additions")] public long Additions { get; init; }
    [JsonPropertyName("removals")] public long Removals { get; init; }
    [JsonPropertyName("binary")] public bool? Binary { get; init; }
}

public record ForkOptions
{
    [JsonPropertyName("restoreFiles")] public bool? RestoreFiles { get; init; }
}

public record ForkPreview
{
    [JsonPropertyName("messageUuid")] public string? MessageUuid { get; init; }
    [JsonPropertyName("canRestoreFiles")] public bool CanRestoreFiles { get; init; }
    [JsonPropertyName("files")] public List<ForkFileChange>? Files { get; init; }
}

public record ForkResultErr : ForkResult
{
    [JsonPropertyName("error")] public string? Error { get; init; }
}

public record ForkResultOk : ForkResult
{
    [JsonPropertyName("sessionId")] public string? SessionId { get; init; }
    [JsonPropertyName("restoredFiles")] public List<string>? RestoredFiles { get; init; }
}

public record BranchResultErr : BranchResult
{
    [JsonPropertyName("error")] public string? Error { get; init; }
}

public record BranchResultOk : BranchResult
{
    [JsonPropertyName("sessionId")] public string? SessionId { get; init; }
}

/// <summary>AddHook 入参：写入 Scope（user / project）对应层的 hooks.json。</summary>
public record HookConfig
{
    [JsonPropertyName("scope")] public HookScope? Scope { get; init; }
    [JsonPropertyName("event")] public string? Event { get; init; }
    /// <summary>仅工具类事件生效；缺省匹配全部工具。</summary>
    [JsonPropertyName("matcher")] public string? Matcher { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    /// <summary>秒，缺省 60。</summary>
    [JsonPropertyName("timeout")] public long? Timeout { get; init; }
    /// <summary>hook 执行失败时按阻断处理，缺省 false。</summary>
    [JsonPropertyName("failClosed")] public bool? FailClosed { get; init; }
}

public record HookEntryInfo
{
    /// <summary>条目标识，RemoveHook / EnableHook / DisableHook 的入参；改了事件、matcher 或命令即变。</summary>
    [JsonPropertyName("id")] public string? Id { get; init; }
    /// <summary>是否启用（settings 的 disabledHooks 控制；host 条目恒为 true）；与 Status 独立。</summary>
    [JsonPropertyName("enabled")] public bool Enabled { get; init; }
    [JsonPropertyName("event")] public string? Event { get; init; }
    [JsonPropertyName("source")] public HookScope? Source { get; init; }
    [JsonPropertyName("pluginName")] public string? PluginName { get; init; }
    [JsonPropertyName("matcher")] public string? Matcher { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    [JsonPropertyName("timeout")] public long? Timeout { get; init; }
    [JsonPropertyName("status")] public HookEntryStatus? Status { get; init; }
    [JsonPropertyName("statusReason")] public string? StatusReason { get; init; }
    /// <summary>"绝对路径:起始行-结束行"（事件块粒度）；host 条目没有配置文件，为 null。</summary>
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
}

public record HookParseError
{
    [JsonPropertyName("source")] public HookScope? Source { get; init; }
    [JsonPropertyName("pluginName")] public string? PluginName { get; init; }
    [JsonPropertyName("message")] public string? Message { get; init; }
}

/// <summary>user / project 域没生效（scopes.hooks 未包含）时对应 ConfigPath 为空串、ConfigExists 恒为 false。</summary>
public record HooksInfo
{
    [JsonPropertyName("userConfigPath")] public string? UserConfigPath { get; init; }
    [JsonPropertyName("projectConfigPath")] public string? ProjectConfigPath { get; init; }
    [JsonPropertyName("userConfigExists")] public bool UserConfigExists { get; init; }
    [JsonPropertyName("projectConfigExists")] public bool ProjectConfigExists { get; init; }
    [JsonPropertyName("parseErrors")] public List<HookParseError>? ParseErrors { get; init; }
    /// <summary>按事件分组，host 在前、插件其次、用户级再次、项目级追加。</summary>
    [JsonPropertyName("events")] public Dictionary<string, List<HookEntryInfo>>? Events { get; init; }
}

public record InputImageAttachment
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("data")] public string? Data { get; init; }
    [JsonPropertyName("media_type")] public string? MediaType { get; init; }
}

public record MCPServerCapabilities
{
    [JsonPropertyName("tools")] public List<MCPToolDefinition>? Tools { get; init; }
}

public record MCPServerConfig
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("transport")] public MCPTransportType? Transport { get; init; }
    [JsonPropertyName("scope")] public MCPScopeType? Scope { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("enabled")] public bool? Enabled { get; init; }
    [JsonPropertyName("useTools")] public List<string>? UseTools { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    [JsonPropertyName("args")] public List<string>? Args { get; init; }
    [JsonPropertyName("env")] public Dictionary<string, string>? Env { get; init; }
    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("headers")] public Dictionary<string, string>? Headers { get; init; }
}

/// <summary>GetMCPServerInfo 等返回项，亦为 mcp:server:status 事件数据；host 条目的 Config.Env / Headers 值打码为 "***"。</summary>
public record MCPServerInfo
{
    [JsonPropertyName("config")] public MCPServerConfig? Config { get; init; }
    [JsonPropertyName("connectStatus")] public MCPServerStatus? ConnectStatus { get; init; }
    [JsonPropertyName("status")] public bool Status { get; init; }
    [JsonPropertyName("capabilities")] public MCPServerCapabilities? Capabilities { get; init; }
    [JsonPropertyName("connectedAt")] public long? ConnectedAt { get; init; }
    [JsonPropertyName("error")] public string? Error { get; init; }
    [JsonPropertyName("scope")] public MCPScopeType? Scope { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
}

public record MCPToolDefinition
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("toolParams")] public MCPToolDefinitionParams? ToolParams { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
}

public record MCPToolDefinitionParams
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("properties")] public Dictionary<string, JsonElement>? Properties { get; init; }
    [JsonPropertyName("required")] public List<string>? Required { get; init; }
}

public record MarketplaceAvailableItem
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("author")] public string? Author { get; init; }
}

public record MarketplaceInfoResult
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("source")] public MarketplaceSource? Source { get; init; }
    [JsonPropertyName("lastUpdated")] public string? LastUpdated { get; init; }
    [JsonPropertyName("available")] public List<MarketplaceAvailableItem>? Available { get; init; }
    [JsonPropertyName("installed")] public List<string>? Installed { get; init; }
}

public record MarketplacePluginsInfo
{
    [JsonPropertyName("marketplaces")] public List<MarketplaceInfoResult>? Marketplaces { get; init; }
    [JsonPropertyName("plugins")] public List<PluginInfoResult>? Plugins { get; init; }
}

public record MarketplaceSource
{
    [JsonPropertyName("source")] public string? Source { get; init; }
    [JsonPropertyName("repo")] public string? Repo { get; init; }
    [JsonPropertyName("path")] public string? Path { get; init; }
}

public record MemoryConfig
{
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("from")] public string? From { get; init; }
    [JsonPropertyName("FilePath")] public string? FilePath { get; init; }
    [JsonPropertyName("refFilePath")] public List<string>? RefFilePath { get; init; }
}

public record ModelConfig
{
    [JsonPropertyName("provider")] public string? Provider { get; init; }
    [JsonPropertyName("modelName")] public string? ModelName { get; init; }
    [JsonPropertyName("baseURL")] public string? BaseURL { get; init; }
    [JsonPropertyName("apiKey")] public string? ApiKey { get; init; }
    [JsonPropertyName("maxTokens")] public long MaxTokens { get; init; }
    [JsonPropertyName("contextLength")] public long ContextLength { get; init; }
    [JsonPropertyName("adapt")] public AdapterType? Adapt { get; init; }
    /// <summary>历史思考回传策略；null 等同 preserve。</summary>
    [JsonPropertyName("thinkingHistoryPolicy")] public ThinkingHistoryPolicy? ThinkingHistoryPolicy { get; init; }
}

/// <summary>GetModelProfile 返回：磁盘上的完整模型 profile，供配置页编辑回填；host 模型的 ApiKey 为空串。</summary>
public record ModelProfile
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("provider")] public string? Provider { get; init; }
    [JsonPropertyName("modelName")] public string? ModelName { get; init; }
    [JsonPropertyName("baseURL")] public string? BaseURL { get; init; }
    [JsonPropertyName("apiKey")] public string? ApiKey { get; init; }
    [JsonPropertyName("maxTokens")] public long MaxTokens { get; init; }
    [JsonPropertyName("contextLength")] public long ContextLength { get; init; }
    [JsonPropertyName("adapt")] public AdapterType? Adapt { get; init; }
    [JsonPropertyName("thinkingHistoryPolicy")] public ThinkingHistoryPolicy? ThinkingHistoryPolicy { get; init; }
}

/// <summary>AddImageModel 入参：文生图模型（进程级，无会话级覆盖）。</summary>
public record ImageModelConfig
{
    [JsonPropertyName("provider")] public string? Provider { get; init; }
    [JsonPropertyName("modelName")] public string? ModelName { get; init; }
    [JsonPropertyName("baseURL")] public string? BaseURL { get; init; }
    [JsonPropertyName("apiKey")] public string? ApiKey { get; init; }
}

/// <summary>GetImageModelProfile 返回：磁盘上的完整文生图模型 profile；Name 形如 qwen-image-3.0[qwen]；host 模型的 ApiKey 为空串。</summary>
public record ImageModelProfile
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("provider")] public string? Provider { get; init; }
    [JsonPropertyName("modelName")] public string? ModelName { get; init; }
    [JsonPropertyName("baseURL")] public string? BaseURL { get; init; }
    [JsonPropertyName("apiKey")] public string? ApiKey { get; init; }
}

public record ModelInfo
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("ownedBy")] public string? OwnedBy { get; init; }
    [JsonPropertyName("key_doc_url")] public string? KeyDocUrl { get; init; }
}

public record ModelUpdateData
{
    [JsonPropertyName("modelName")] public string? ModelName { get; init; }
    [JsonPropertyName("modelList")] public List<string>? ModelList { get; init; }
    [JsonPropertyName("taskConfig")] public TaskConfig? TaskConfig { get; init; }
    /// <summary>文生图模型列表（与 ModelList 分开）。</summary>
    [JsonPropertyName("imageModelList")] public List<string>? ImageModelList { get; init; }
    /// <summary>来自宿主（host 域）的模型名，含对话与文生图模型；只读，不可删改。</summary>
    [JsonPropertyName("hostModels")] public List<string>? HostModels { get; init; }
}

public record PluginComponentEntry
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
}

public record PluginComponents
{
    [JsonPropertyName("commands")] public List<PluginComponentEntry>? Commands { get; init; }
    [JsonPropertyName("agents")] public List<PluginComponentEntry>? Agents { get; init; }
    [JsonPropertyName("skills")] public List<PluginComponentEntry>? Skills { get; init; }
    [JsonPropertyName("mcp")] public List<PluginComponentEntry>? Mcp { get; init; }
    [JsonPropertyName("hooks")] public List<PluginComponentEntry>? Hooks { get; init; }
}

public record PluginInfoResult
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("marketplace")] public string? Marketplace { get; init; }
    [JsonPropertyName("scope")] public PluginScopeKind? Scope { get; init; }
    [JsonPropertyName("status")] public bool Status { get; init; }
    [JsonPropertyName("version")] public string? Version { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("author")] public string? Author { get; init; }
    [JsonPropertyName("components")] public PluginComponents? Components { get; init; }
}

public record RuleConfig
{
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("locate")] public RuleScope? Locate { get; init; }
    [JsonPropertyName("from")] public string? From { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
}

public record SemaCoreConfig
{
    /// <summary>构造配置文件路径（~/xx 或绝对路径，由桥进程读取）：严格 JSON，字段同本类型；这里显式传的顶层键整体覆盖文件里的同名键；文件内 {"$file": "路径"} 替换为该文件文本。</summary>
    [JsonPropertyName("configFile")] public string? ConfigFile { get; init; }
    [JsonPropertyName("workingDir")] public string? WorkingDir { get; init; }
    [JsonPropertyName("logLevel")] public string? LogLevel { get; init; }
    [JsonPropertyName("lang")] public string? Lang { get; init; }
    [JsonPropertyName("stream")] public bool? Stream { get; init; }
    [JsonPropertyName("thinking")] public bool? Thinking { get; init; }
    [JsonPropertyName("systemPrompt")] public string? SystemPrompt { get; init; }
    [JsonPropertyName("systemPromptMode")] public SystemPromptMode? SystemPromptMode { get; init; }
    [JsonPropertyName("customRules")] public string? CustomRules { get; init; }
    [JsonPropertyName("skipFileEditPermission")] public bool? SkipFileEditPermission { get; init; }
    [JsonPropertyName("skipShellExecPermission")] public bool? SkipShellExecPermission { get; init; }
    [JsonPropertyName("skipSkillPermission")] public bool? SkipSkillPermission { get; init; }
    [JsonPropertyName("skipMCPToolPermission")] public bool? SkipMCPToolPermission { get; init; }
    [JsonPropertyName("skipFetchUrlPermission")] public bool? SkipFetchUrlPermission { get; init; }
    [JsonPropertyName("fetchUrlBrowserUserAgent")] public bool? FetchUrlBrowserUserAgent { get; init; }
    [JsonPropertyName("skipExternalFileReadPermission")] public bool? SkipExternalFileReadPermission { get; init; }
    [JsonPropertyName("useTools")] public List<string>? UseTools { get; init; }
    [JsonPropertyName("disabledTools")] public List<string>? DisabledTools { get; init; }
    [JsonPropertyName("agentMode")] public AgentMode? AgentMode { get; init; }
    [JsonPropertyName("disableTopicDetection")] public bool? DisableTopicDetection { get; init; }
    /// <summary>一轮结束后用 quick 模型预测用户下一句（事件 input:predict），默认否。</summary>
    [JsonPropertyName("enableInputPrediction")] public bool? EnableInputPrediction { get; init; }
    [JsonPropertyName("disableBackgroundTasks")] public bool? DisableBackgroundTasks { get; init; }
    /// <summary>关闭内置记忆（不拼记忆提示词、不注入 MEMORY.md、不读 .sema/memory、记忆文件编辑豁免失效）。仅构造时生效。</summary>
    [JsonPropertyName("disableMemory")] public bool? DisableMemory { get; init; }
    [JsonPropertyName("enableToolSearch")] public bool? EnableToolSearch { get; init; }
    [JsonPropertyName("toolSearchDefaultTools")] public List<string>? ToolSearchDefaultTools { get; init; }
    [JsonPropertyName("maxSessions")] public long? MaxSessions { get; init; }
    /// <summary>使用统计的产品标识（如 sema-code-vscode）；null 或空串则本进程不采集。仅构造时生效。</summary>
    [JsonPropertyName("usageProduct")] public string? UsageProduct { get; init; }

    // ---- 来源限定：host 域内容与各类生效的域，仅构造时生效；校验不通过 Start 抛 CONFIG_INVALID ----
    /// <summary>宿主内置的模型与指针；host 模型只读，查询接口不回传 apiKey。</summary>
    [JsonPropertyName("models")] public ModelsInput? Models { get; init; }
    /// <summary>宿主内置的 MCP 服务；查询接口与状态事件里 env / headers 值打码。</summary>
    [JsonPropertyName("mcpServers")] public List<MCPServerInput>? McpServers { get; init; }
    /// <summary>宿主内置的 hook：即 hooks.json 里 hooks 字段的内容，键为事件名。</summary>
    [JsonPropertyName("hooks")] public Dictionary<string, List<HookGroupInput>>? Hooks { get; init; }
    /// <summary>宿主内置的 skill：Items 内联（正文只在内存）、Dirs 明文目录。</summary>
    [JsonPropertyName("skills")] public SkillsInput? Skills { get; init; }
    /// <summary>宿主内置的子代理，结构同 Skills。</summary>
    [JsonPropertyName("agents")] public AgentsInput? Agents { get; init; }
    /// <summary>宿主内置的命令，结构同 Skills。</summary>
    [JsonPropertyName("commands")] public CommandsInput? Commands { get; init; }
    /// <summary>各类生效的域，不写 = 全部生效。</summary>
    [JsonPropertyName("scopes")] public ScopesConfig? Scopes { get; init; }

    // ---- 持久化保护 ----
    /// <summary>会话历史、hook 会话记录、快照加密；密钥只在内存。仅构造时生效。</summary>
    [JsonPropertyName("encryption")] public EncryptionConfig? Encryption { get; init; }
    /// <summary>不写模型调用日志；缺省：没传 Encryption 为 false，传了为 true。支持运行期更新。</summary>
    [JsonPropertyName("disableLLMLog")] public bool? DisableLLMLog { get; init; }
    /// <summary>不写事件日志；缺省规则同 DisableLLMLog。支持运行期更新。</summary>
    [JsonPropertyName("disableEventLog")] public bool? DisableEventLog { get; init; }
}

// ==================== host 域内容 / 生效域 / 持久化保护（≙ core types/host.ts）====================
// 宿主在构造参数里传入的模型 / MCP / hook / skill / 子代理 / 命令叫 host 域：只读、同名盖掉其他域、不落盘；
// Scopes 指定每一类哪些域生效，不写 = 全部生效。均只在构造时生效。

/// <summary>宿主内置的模型列表与指针（字段同 AddModel / AddImageModel 入参）。Main / Quick / Image 为 "modelName[provider]"，是没有用户选择时的缺省值：Main 缺省取 Profiles[0]，Quick 缺省同 Main，Image 缺省取 ImageProfiles[0]、传 "" 停用文生图。</summary>
public record ModelsInput
{
    [JsonPropertyName("profiles")] public List<ModelConfig>? Profiles { get; init; }
    [JsonPropertyName("imageProfiles")] public List<ImageModelConfig>? ImageProfiles { get; init; }
    [JsonPropertyName("main")] public string? Main { get; init; }
    [JsonPropertyName("quick")] public string? Quick { get; init; }
    [JsonPropertyName("image")] public string? Image { get; init; }
}

/// <summary>宿主内置的 MCP 服务（字段同 AddMCPServer 入参，去掉 scope）。Enabled 默认 true，不受 settings 的 disabledMcpServers 影响；UseTools 为允许的工具名，null 表示全部。</summary>
public record MCPServerInput
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("transport")] public MCPTransportType? Transport { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    [JsonPropertyName("args")] public List<string>? Args { get; init; }
    [JsonPropertyName("env")] public Dictionary<string, string>? Env { get; init; }
    [JsonPropertyName("url")] public string? Url { get; init; }
    [JsonPropertyName("headers")] public Dictionary<string, string>? Headers { get; init; }
    [JsonPropertyName("enabled")] public bool? Enabled { get; init; }
    [JsonPropertyName("useTools")] public List<string>? UseTools { get; init; }
}

/// <summary>宿主内置 hook 的一条命令（hooks.json 里 hooks[].hooks[] 的元素）；Type 只支持 "command"，缺省即是；Timeout 单位秒。</summary>
public record HookCommandInput
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    [JsonPropertyName("timeout")] public long? Timeout { get; init; }
    [JsonPropertyName("failClosed")] public bool? FailClosed { get; init; }
}

/// <summary>宿主内置 hook 的一个 matcher 组；SemaCoreConfig.Hooks 为 Dictionary&lt;事件名, List&lt;HookGroupInput&gt;&gt;（≙ core HooksInput）。</summary>
public record HookGroupInput
{
    [JsonPropertyName("matcher")] public string? Matcher { get; init; }
    [JsonPropertyName("hooks")] public List<HookCommandInput>? Hooks { get; init; }
}

/// <summary>内联 skill：正文与文本子文件只在内存里，磁盘上不留。Prompt 为 SKILL.md 正文；Files 为文本子文件（相对路径 → 内容，模型用 skill 工具的 file 参数读）；ResourceDir 为脚本、图片、模板等所在的磁盘目录（绝对路径），不保护。</summary>
public record SkillInput
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("files")] public Dictionary<string, string>? Files { get; init; }
    [JsonPropertyName("resourceDir")] public string? ResourceDir { get; init; }
}

/// <summary>宿主内置的 skill：Items 内联、Dirs 为产品自带的明文目录（每个目录下是 &lt;skill 名&gt;/SKILL.md）。</summary>
public record SkillsInput
{
    [JsonPropertyName("items")] public List<SkillInput>? Items { get; init; }
    [JsonPropertyName("dirs")] public List<string>? Dirs { get; init; }
}

/// <summary>内联子代理（字段同 AddAgentConf 入参，去掉 locate）。Tools 为 string[] 或字符串 "*"（默认 "*"）；Model 为 "quick" 对应快速模型，其他值均对应主模型。</summary>
public record AgentInput
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("tools")] public JsonElement? Tools { get; init; }
    [JsonPropertyName("model")] public string? Model { get; init; }
}

/// <summary>宿主内置的子代理：Items 内联、Dirs 为产品自带的明文目录（每个目录下是 &lt;name&gt;.md）。</summary>
public record AgentsInput
{
    [JsonPropertyName("items")] public List<AgentInput>? Items { get; init; }
    [JsonPropertyName("dirs")] public List<string>? Dirs { get; init; }
}

/// <summary>内联命令（字段同 AddCommandConf 入参，去掉 locate）；ArgumentHint 为 string 或 string[]。</summary>
public record CommandInput
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("argumentHint")] public JsonElement? ArgumentHint { get; init; }
}

/// <summary>宿主内置的命令：Items 内联、Dirs 为产品自带的明文目录（每个目录下是 &lt;name&gt;.md，子目录成为 dir:name）。</summary>
public record CommandsInput
{
    [JsonPropertyName("items")] public List<CommandInput>? Items { get; init; }
    [JsonPropertyName("dirs")] public List<string>? Dirs { get; init; }
}

/// <summary>
/// 各类生效的域；null = 该类全部域生效，要锁定必须显式写。值为域名字符串：
/// Models: host / user；Mcp、Hooks、Commands: host / user / project；Skills、Agents: host / builtin / user / project；
/// Plugins 没有 host 域，值是插件安装位置（PluginScopeKind），空列表表示不加载任何插件。
/// </summary>
public record ScopesConfig
{
    [JsonPropertyName("models")] public List<string>? Models { get; init; }
    [JsonPropertyName("mcp")] public List<string>? Mcp { get; init; }
    [JsonPropertyName("hooks")] public List<string>? Hooks { get; init; }
    [JsonPropertyName("skills")] public List<string>? Skills { get; init; }
    [JsonPropertyName("agents")] public List<string>? Agents { get; init; }
    [JsonPropertyName("commands")] public List<string>? Commands { get; init; }
    [JsonPropertyName("plugins")] public List<PluginScopeKind>? Plugins { get; init; }
}

/// <summary>会话历史、hook 会话记录、快照加密；密钥只在内存。Key 为 32 字节随机密钥的 base64（44 个字符）；KeyId 可选，写进密文开头，不能含 ':' 或换行。</summary>
public record EncryptionConfig
{
    [JsonPropertyName("key")] public string? Key { get; init; }
    [JsonPropertyName("keyId")] public string? KeyId { get; init; }
}

// ==================== 使用统计（GetUsageStats）====================

/// <summary>hit=缓存命中的输入 token，miss=未命中缓存的输入 token，output=输出 token。</summary>
public record UsageTokens
{
    [JsonPropertyName("hit")] public long Hit { get; init; }
    [JsonPropertyName("miss")] public long Miss { get; init; }
    [JsonPropertyName("output")] public long Output { get; init; }
}

public record UsageModelStat
{
    [JsonPropertyName("requests")] public long Requests { get; init; }
    /// <summary>服务商是否返回过缓存命中数；false 时 Tokens.Hit 恒为 0，Miss 即总输入。</summary>
    [JsonPropertyName("hitKnown")] public bool HitKnown { get; init; }
    [JsonPropertyName("tokens")] public UsageTokens? Tokens { get; init; }
}

public record UsageToolStat
{
    [JsonPropertyName("calls")] public long Calls { get; init; }
    [JsonPropertyName("errors")] public long Errors { get; init; }
}

public record UsageSkillStat
{
    [JsonPropertyName("calls")] public long Calls { get; init; }
    /// <summary>最近一次调用时间戳（毫秒）。</summary>
    [JsonPropertyName("lastAt")] public long LastAt { get; init; }
}

/// <summary>单日聚合：Models/Tools/Skills 按名称聚合，Sessions 为当天去重后的会话 id。</summary>
public record UsageDayData
{
    [JsonPropertyName("requests")] public long Requests { get; init; }
    [JsonPropertyName("tokens")] public UsageTokens? Tokens { get; init; }
    [JsonPropertyName("models")] public Dictionary<string, UsageModelStat>? Models { get; init; }
    [JsonPropertyName("tools")] public Dictionary<string, UsageToolStat>? Tools { get; init; }
    [JsonPropertyName("skills")] public Dictionary<string, UsageSkillStat>? Skills { get; init; }
    [JsonPropertyName("sessions")] public List<string>? Sessions { get; init; }
}

/// <summary>累计：Sessions 为全部记录 sessionId 去重数，Days 为有记录的日期数。</summary>
public record UsageTotals
{
    [JsonPropertyName("requests")] public long Requests { get; init; }
    [JsonPropertyName("tokens")] public UsageTokens? Tokens { get; init; }
    [JsonPropertyName("sessions")] public long Sessions { get; init; }
    [JsonPropertyName("days")] public long Days { get; init; }
}

/// <summary>GetUsageStats 返回：Since=最早记录日期 'YYYY-MM-DD'（无数据为 null），Days 只含近 366 天且有记录的日期。</summary>
public record UsageStatsData
{
    [JsonPropertyName("since")] public string? Since { get; init; }
    [JsonPropertyName("updatedAt")] public long UpdatedAt { get; init; }
    [JsonPropertyName("totals")] public UsageTotals? Totals { get; init; }
    [JsonPropertyName("days")] public Dictionary<string, UsageDayData>? Days { get; init; }
}

public record SkillConfig
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    /// <summary>内联（Private）skill 在查询接口里为空串。</summary>
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("locate")] public SkillScope? Locate { get; init; }
    /// <summary>SKILL.md 路径；内联 skill 没有。</summary>
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    /// <summary>是否启用（settings 的 disabledSkills 控制，用户级+项目级并集；null 视为启用；builtin / host 恒为启用）。</summary>
    [JsonPropertyName("status")] public bool? Status { get; init; }
    /// <summary>宿主内联传入：正文与文本子文件只在内存里，不出现在查询接口与事件里。</summary>
    [JsonPropertyName("private")] public bool? Private { get; init; }
    /// <summary>内联 skill 的脚本、资源所在磁盘目录（绝对路径）。</summary>
    [JsonPropertyName("resourceDir")] public string? ResourceDir { get; init; }
}

public record TaskConfig
{
    [JsonPropertyName("main")] public string? Main { get; init; }
    [JsonPropertyName("quick")] public string? Quick { get; init; }
    /// <summary>文生图模型指针，只在返回值里出现；空串/null 表示未启用。ApplyTaskModel 入参只用 Main/Quick。</summary>
    [JsonPropertyName("image")] public string? Image { get; init; }
}

public record TaskListItem
{
    [JsonPropertyName("taskId")] public string? TaskId { get; init; }
    [JsonPropertyName("filepath")] public string? Filepath { get; init; }
    [JsonPropertyName("status")] public CronTaskStatus? Status { get; init; }
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    [JsonPropertyName("startTime")] public long StartTime { get; init; }
    [JsonPropertyName("pid")] public long? Pid { get; init; }
    [JsonPropertyName("agentType")] public string? AgentType { get; init; }
    [JsonPropertyName("foreground")] public bool? Foreground { get; init; }
    [JsonPropertyName("endTime")] public long? EndTime { get; init; }
}

public record TodoItem
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("status")] public TodoTaskStatus? Status { get; init; }
    [JsonPropertyName("progressText")] public string? ProgressText { get; init; }
}

public record TodoTask
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("status")] public TodoTaskStatus? Status { get; init; }
    [JsonPropertyName("blocks")] public List<string>? Blocks { get; init; }
    [JsonPropertyName("blockedBy")] public List<string>? BlockedBy { get; init; }
    [JsonPropertyName("createdAt")] public long CreatedAt { get; init; }
    [JsonPropertyName("updatedAt")] public long UpdatedAt { get; init; }
    [JsonPropertyName("progressText")] public string? ProgressText { get; init; }
}

/// <summary>
/// 长期目标（/goal）状态（≙ core GoalState）：GetGoal 返回值与 goal:update 事件载荷。
/// Round 起始为 1、仅自动续轮加一；MaxRounds 因上限暂停后 resume 时累加；IdleRounds 为连续无 tool_use 的目标轮数；
/// Summary 为模型自报完成 / 受阻时给出的总结。
/// </summary>
public record GoalState
{
    [JsonPropertyName("text")] public string? Text { get; init; }
    [JsonPropertyName("status")] public GoalStatus? Status { get; init; }
    [JsonPropertyName("round")] public int Round { get; init; }
    [JsonPropertyName("maxRounds")] public int MaxRounds { get; init; }
    [JsonPropertyName("idleRounds")] public int IdleRounds { get; init; }
    [JsonPropertyName("summary")] public string? Summary { get; init; }
    [JsonPropertyName("createdAt")] public long CreatedAt { get; init; }
    [JsonPropertyName("updatedAt")] public long UpdatedAt { get; init; }
}

public record ToolInfo
{
    [JsonPropertyName("name")] public string? Name { get; init; }
    [JsonPropertyName("description")] public string? Description { get; init; }
    [JsonPropertyName("status")] public ToolStatus? Status { get; init; }
}

public record UpdatableCoreConfig
{
    [JsonPropertyName("lang")] public string? Lang { get; init; }
    [JsonPropertyName("stream")] public bool? Stream { get; init; }
    [JsonPropertyName("thinking")] public bool? Thinking { get; init; }
    [JsonPropertyName("systemPrompt")] public string? SystemPrompt { get; init; }
    [JsonPropertyName("customRules")] public string? CustomRules { get; init; }
    [JsonPropertyName("skipFileEditPermission")] public bool? SkipFileEditPermission { get; init; }
    [JsonPropertyName("skipShellExecPermission")] public bool? SkipShellExecPermission { get; init; }
    [JsonPropertyName("skipSkillPermission")] public bool? SkipSkillPermission { get; init; }
    [JsonPropertyName("skipMCPToolPermission")] public bool? SkipMCPToolPermission { get; init; }
    [JsonPropertyName("skipFetchUrlPermission")] public bool? SkipFetchUrlPermission { get; init; }
    [JsonPropertyName("fetchUrlBrowserUserAgent")] public bool? FetchUrlBrowserUserAgent { get; init; }
    [JsonPropertyName("skipExternalFileReadPermission")] public bool? SkipExternalFileReadPermission { get; init; }
    [JsonPropertyName("disableBackgroundTasks")] public bool? DisableBackgroundTasks { get; init; }
    [JsonPropertyName("enableToolSearch")] public bool? EnableToolSearch { get; init; }
    [JsonPropertyName("enableInputPrediction")] public bool? EnableInputPrediction { get; init; }
    [JsonPropertyName("disableLLMLog")] public bool? DisableLLMLog { get; init; }
    [JsonPropertyName("disableEventLog")] public bool? DisableEventLog { get; init; }
}

/// <summary>镜像 sema-core 从 types 入口导出的常量（≙ import { MAIN_AGENT_ID } from 'sema-core/types'）。</summary>
public static class Constants
{
    /// <summary>主代理 agentId；message:complete 等事件按此区分主/子代理。</summary>
    public const string MAIN_AGENT_ID = "main";
}

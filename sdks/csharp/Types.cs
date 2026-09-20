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

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AgentScope { user, project, builtin, plugin }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum AppSessionState { idle, processing }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CommandScope { user, project, plugin }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum CronTaskStatus { running, completed, failed, killed }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ForkFileEffect { modify, recreate, delete }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum HookEntryStatus { ok, skipped, invalid }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum HookScope { user, project, plugin }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum MCPScopeType { local, project, user, plugin }

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

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SkillScope { user, project, plugin, builtin }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum SystemPromptMode { append, replace, replaceAll }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum TodoTaskStatus { pending, in_progress, completed }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ToolStatus { enable, disable }

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum UpdatableCoreConfigKeys { lang, stream, thinking, systemPrompt, customRules, skipFileEditPermission, skipShellExecPermission, skipSkillPermission, skipMCPToolPermission, skipFetchUrlPermission, fetchUrlBrowserUserAgent, skipExternalFileReadPermission, enableLLMCache, disableBackgroundTasks, enableToolSearch }

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
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("locate")] public AgentScope? Locate { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
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
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("argumentHint")] public JsonElement? ArgumentHint { get; init; }
    [JsonPropertyName("locate")] public CommandScope? Locate { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
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

public record CreateSessionResultErr : CreateSessionResult
{
    [JsonPropertyName("error")] public string? Error { get; init; }
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

public record HookEntryInfo
{
    [JsonPropertyName("event")] public string? Event { get; init; }
    [JsonPropertyName("source")] public HookScope? Source { get; init; }
    [JsonPropertyName("pluginName")] public string? PluginName { get; init; }
    [JsonPropertyName("matcher")] public string? Matcher { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    [JsonPropertyName("timeout")] public long? Timeout { get; init; }
    [JsonPropertyName("status")] public HookEntryStatus? Status { get; init; }
    [JsonPropertyName("statusReason")] public string? StatusReason { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
}

public record HookParseError
{
    [JsonPropertyName("source")] public HookScope? Source { get; init; }
    [JsonPropertyName("pluginName")] public string? PluginName { get; init; }
    [JsonPropertyName("message")] public string? Message { get; init; }
}

public record HooksInfo
{
    [JsonPropertyName("userConfigPath")] public string? UserConfigPath { get; init; }
    [JsonPropertyName("projectConfigPath")] public string? ProjectConfigPath { get; init; }
    [JsonPropertyName("userConfigExists")] public bool UserConfigExists { get; init; }
    [JsonPropertyName("projectConfigExists")] public bool ProjectConfigExists { get; init; }
    [JsonPropertyName("parseErrors")] public List<HookParseError>? ParseErrors { get; init; }
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

/// <summary>GetModelProfile 返回：磁盘上的完整模型 profile，供配置页编辑回填。</summary>
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
    [JsonPropertyName("enableLLMCache")] public bool? EnableLLMCache { get; init; }
    [JsonPropertyName("useTools")] public List<string>? UseTools { get; init; }
    [JsonPropertyName("disabledTools")] public List<string>? DisabledTools { get; init; }
    [JsonPropertyName("agentMode")] public AgentMode? AgentMode { get; init; }
    [JsonPropertyName("disableTopicDetection")] public bool? DisableTopicDetection { get; init; }
    [JsonPropertyName("disableBackgroundTasks")] public bool? DisableBackgroundTasks { get; init; }
    [JsonPropertyName("enableToolSearch")] public bool? EnableToolSearch { get; init; }
    [JsonPropertyName("toolSearchDefaultTools")] public List<string>? ToolSearchDefaultTools { get; init; }
    [JsonPropertyName("maxSessions")] public long? MaxSessions { get; init; }
    /// <summary>使用统计的产品标识（如 sema-code-vscode）；null 或空串则本进程不采集。仅构造时生效。</summary>
    [JsonPropertyName("usageProduct")] public string? UsageProduct { get; init; }
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
    [JsonPropertyName("prompt")] public string? Prompt { get; init; }
    [JsonPropertyName("locate")] public SkillScope? Locate { get; init; }
    [JsonPropertyName("filePath")] public string? FilePath { get; init; }
    /// <summary>是否启用（settings 的 disabledSkills 控制，用户级+项目级并集；null 视为启用）。</summary>
    [JsonPropertyName("status")] public bool? Status { get; init; }
}

public record TaskConfig
{
    [JsonPropertyName("main")] public string? Main { get; init; }
    [JsonPropertyName("quick")] public string? Quick { get; init; }
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
    [JsonPropertyName("enableLLMCache")] public bool? EnableLLMCache { get; init; }
    [JsonPropertyName("disableBackgroundTasks")] public bool? DisableBackgroundTasks { get; init; }
    [JsonPropertyName("enableToolSearch")] public bool? EnableToolSearch { get; init; }
}

/// <summary>镜像 sema-core 从 types 入口导出的常量（≙ import { MAIN_AGENT_ID } from 'sema-core/types'）。</summary>
public static class Constants
{
    /// <summary>主代理 agentId；message:complete 等事件按此区分主/子代理。</summary>
    public const string MAIN_AGENT_ID = "main";
}

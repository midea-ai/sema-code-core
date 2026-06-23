using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace SemaDemo;

/// <summary>
/// SemaCore 初始化配置，对应 sema-core 的 SemaCoreConfig 接口
/// </summary>
public class SemaCoreConfig
{
    /// <summary>Agent 操作的目标代码仓库绝对路径</summary>
    [JsonProperty("workingDir", NullValueHandling = NullValueHandling.Ignore)]
    public string? WorkingDir { get; set; }

    /// <summary>日志级别，默认 info</summary>
    [JsonProperty("logLevel", NullValueHandling = NullValueHandling.Ignore)]
    public string? LogLevel { get; set; }

    /// <summary>流式输出 AI 响应，默认 true</summary>
    [JsonProperty("stream", NullValueHandling = NullValueHandling.Ignore)]
    public bool? Stream { get; set; }

    /// <summary>输出思考过程，默认 false</summary>
    [JsonProperty("thinking", NullValueHandling = NullValueHandling.Ignore)]
    public bool? Thinking { get; set; }

    /// <summary>系统提示词</summary>
    [JsonProperty("systemPrompt", NullValueHandling = NullValueHandling.Ignore)]
    public string? SystemPrompt { get; set; }

    /// <summary>用户自定义规则</summary>
    [JsonProperty("customRules", NullValueHandling = NullValueHandling.Ignore)]
    public string? CustomRules { get; set; }

    /// <summary>跳过文件编辑权限检查，默认 false</summary>
    [JsonProperty("skipFileEditPermission", NullValueHandling = NullValueHandling.Ignore)]
    public bool? SkipFileEditPermission { get; set; }

    /// <summary>跳过 Shell 执行权限检查，默认 false</summary>
    [JsonProperty("skipShellExecPermission", NullValueHandling = NullValueHandling.Ignore)]
    public bool? SkipShellExecPermission { get; set; }

    /// <summary>跳过 Skill 权限检查，默认 false</summary>
    [JsonProperty("skipSkillPermission", NullValueHandling = NullValueHandling.Ignore)]
    public bool? SkipSkillPermission { get; set; }

    /// <summary>跳过 MCP 工具权限检查，默认 false</summary>
    [JsonProperty("skipMCPToolPermission", NullValueHandling = NullValueHandling.Ignore)]
    public bool? SkipMCPToolPermission { get; set; }

    /// <summary>开启 LLM 缓存，默认 false，建议只在重复测试时使用</summary>
    [JsonProperty("enableLLMCache", NullValueHandling = NullValueHandling.Ignore)]
    public bool? EnableLLMCache { get; set; }

    /// <summary>跳过 fetch_url 权限检查，默认 false</summary>
    [JsonProperty("skipFetchUrlPermission", NullValueHandling = NullValueHandling.Ignore)]
    public bool? SkipFetchUrlPermission { get; set; }

    /// <summary>限定使用的工具列表（白名单），null 表示使用所有工具</summary>
    [JsonProperty("useTools", NullValueHandling = NullValueHandling.Ignore)]
    public string[]? UseTools { get; set; }

    /// <summary>禁用的工具列表（黑名单），null 表示不禁用。与 useTools 同时传时优先生效</summary>
    [JsonProperty("disabledTools", NullValueHandling = NullValueHandling.Ignore)]
    public string[]? DisabledTools { get; set; }

    /// <summary>Agent 模式：Agent 或 Plan，默认 Agent</summary>
    [JsonProperty("agentMode", NullValueHandling = NullValueHandling.Ignore)]
    public string? AgentMode { get; set; }

    /// <summary>是否禁用话题检测，默认 false</summary>
    [JsonProperty("disableTopicDetection", NullValueHandling = NullValueHandling.Ignore)]
    public bool? DisableTopicDetection { get; set; }

    /// <summary>是否禁止后台任务，默认 false</summary>
    [JsonProperty("disableBackgroundTasks", NullValueHandling = NullValueHandling.Ignore)]
    public bool? DisableBackgroundTasks { get; set; }
}


/// <summary>
/// 宿主 → Node.js 指令帧
/// </summary>
public class BridgeCommand
{
    [JsonProperty("id")]
    public string Id { get; set; } = Guid.NewGuid().ToString("N")[..8];

    [JsonProperty("action")]
    public string Action { get; set; } = "";

    [JsonProperty("payload")]
    public object? Payload { get; set; }

    public BridgeCommand(string action, object? payload = null)
    {
        Action = action;
        Payload = payload;
    }
}

/// <summary>
/// Node.js → 宿主 事件帧
/// </summary>
public class BridgeEvent
{
    [JsonProperty("event")]
    public string Event { get; set; } = "";

    [JsonProperty("data")]
    public JToken? Data { get; set; }

    [JsonProperty("cmdId")]
    public string? CmdId { get; set; }

    [JsonProperty("error")]
    public string? Error { get; set; }
}

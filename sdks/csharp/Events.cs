// ≙ 'sema-core/event' 入口（单文件聚合，≙ Python event.py）。由 sdks/shared 契约镜像生成；
// wire 字段名 = camelCase（JsonPropertyName 标注），与 sema-core / Python / Java SDK 完全一致。
using System.Text.Json;
using System.Text.Json.Serialization;
using Semacore.Types;

namespace Semacore.Events;

/// <summary>
/// 问答题型判别联合（≙ core PickOptionQuestion = Radio | Checkbox | Select | Text | Textarea）。
/// 反序列化自动按 wire <c>"type"</c> 分派到具体子类（STJ 多态）；<see cref="Type"/> 为判别值只读镜像。
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "type", UnknownDerivedTypeHandling = JsonUnknownDerivedTypeHandling.FailSerialization)]
[JsonDerivedType(typeof(RadioQuestion), "radio")]
[JsonDerivedType(typeof(CheckboxQuestion), "checkbox")]
[JsonDerivedType(typeof(SelectQuestion), "select")]
[JsonDerivedType(typeof(TextQuestion), "text")]
[JsonDerivedType(typeof(TextareaQuestion), "textarea")]
public abstract record PickOptionQuestion
{
    /// <summary>wire "type" 判别值（radio / checkbox / select / text / textarea）。</summary>
    [JsonIgnore] public abstract string Type { get; }
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("label")] public string? Label { get; init; }
}

public record CheckboxQuestion : PickOptionQuestion
{
    [JsonPropertyName("options")] public List<string>? Options { get; init; }
    [JsonPropertyName("required")] public bool? Required { get; init; }
    [JsonPropertyName("maxSelections")] public long? MaxSelections { get; init; }
    [JsonIgnore] public override string Type => "checkbox";
}

public record CompactExecData
{
    [JsonPropertyName("tokenBefore")] public long TokenBefore { get; init; }
    [JsonPropertyName("tokenCompact")] public long TokenCompact { get; init; }
    [JsonPropertyName("compactRate")] public double CompactRate { get; init; }
    [JsonPropertyName("errMsg")] public string? ErrMsg { get; init; }
    [JsonPropertyName("mode")] public string? Mode { get; init; }
    [JsonPropertyName("reason")] public string? Reason { get; init; }
}

public record CompactMicroData
{
    [JsonPropertyName("clearedCount")] public long ClearedCount { get; init; }
    [JsonPropertyName("estimatedSavedTokens")] public long EstimatedSavedTokens { get; init; }
    [JsonPropertyName("estimatedTokenAfter")] public long EstimatedTokenAfter { get; init; }
    [JsonPropertyName("skippedFullCompact")] public bool SkippedFullCompact { get; init; }
}

public record ConversationUsageData
{
    [JsonPropertyName("usage")] public Usage? Usage { get; init; }
}

public record CronUpdateData;

public record FileReferenceData
{
    [JsonPropertyName("references")] public List<FileReferenceInfo>? References { get; init; }
}

public record InputProcessingData
{
    [JsonPropertyName("inputId")] public string? InputId { get; init; }
    [JsonPropertyName("input")] public string? Input { get; init; }
    [JsonPropertyName("originalInput")] public string? OriginalInput { get; init; }
    [JsonPropertyName("attachments")] public List<InputImageAttachment>? Attachments { get; init; }
}

public record InputReceivedData
{
    [JsonPropertyName("inputId")] public string? InputId { get; init; }
    [JsonPropertyName("input")] public string? Input { get; init; }
    [JsonPropertyName("queued")] public bool Queued { get; init; }
    [JsonPropertyName("queueLength")] public long QueueLength { get; init; }
    [JsonPropertyName("originalInput")] public string? OriginalInput { get; init; }
}

public record MCPServerStatusData
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

public record MessageCompleteData
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("reasoning")] public string? Reasoning { get; init; }
    [JsonPropertyName("content")] public string? Content { get; init; }
    [JsonPropertyName("hasToolCalls")] public bool HasToolCalls { get; init; }
    [JsonPropertyName("toolCalls")] public List<MessageToolCall>? ToolCalls { get; init; }
}

public record MessageToolCall
{
    [JsonPropertyName("name")] public string? Name { get; init; }
}

public record PermissionLevelUpdateData
{
    [JsonPropertyName("level")] public PermissionLevel? Level { get; init; }
}

public record PickOptionRequestData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("questions")] public List<PickOptionQuestion>? Questions { get; init; }
    [JsonPropertyName("estimatedTime")] public string? EstimatedTime { get; init; }
    [JsonPropertyName("intro")] public string? Intro { get; init; }
}

public record PickOptionResponseData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("answers")] public string? Answers { get; init; }
}

public record PlanExitRequestData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("planFilePath")] public string? PlanFilePath { get; init; }
    [JsonPropertyName("planContent")] public string? PlanContent { get; init; }
    [JsonPropertyName("options")] public PlanExitRequestOptions? Options { get; init; }
}

public record PlanExitRequestOptions
{
    [JsonPropertyName("startEditing")] public string? StartEditing { get; init; }
    [JsonPropertyName("clearContextAndStart")] public string? ClearContextAndStart { get; init; }
}

public record PlanExitResponseData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("selected")] public string? Selected { get; init; }
}

public record PlanImplementData
{
    [JsonPropertyName("planFilePath")] public string? PlanFilePath { get; init; }
    [JsonPropertyName("planContent")] public string? PlanContent { get; init; }
}

public record RadioQuestion : PickOptionQuestion
{
    [JsonPropertyName("options")] public List<string>? Options { get; init; }
    [JsonPropertyName("required")] public bool? Required { get; init; }
    [JsonIgnore] public override string Type => "radio";
}

public record SelectQuestion : PickOptionQuestion
{
    [JsonPropertyName("options")] public List<string>? Options { get; init; }
    [JsonPropertyName("required")] public bool? Required { get; init; }
    [JsonIgnore] public override string Type => "select";
}

public record SessionClearedData
{
    [JsonPropertyName("sessionId")] public string? SessionId { get; init; }
}

public record SessionErrorData
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("error")] public SessionErrorDetail? Error { get; init; }
}

public record SessionErrorDetail
{
    [JsonPropertyName("code")] public string? Code { get; init; }
    [JsonPropertyName("message")] public string? Message { get; init; }
    [JsonPropertyName("details")] public JsonElement? Details { get; init; }
}

public record SessionInterruptedData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("content")] public string? Content { get; init; }
}

public record SessionReadyData
{
    [JsonPropertyName("pid")] public long Pid { get; init; }
    [JsonPropertyName("workingDir")] public string? WorkingDir { get; init; }
    [JsonPropertyName("sessionId")] public string? SessionId { get; init; }
    [JsonPropertyName("historyLoaded")] public bool HistoryLoaded { get; init; }
    [JsonPropertyName("usage")] public Usage? Usage { get; init; }
    [JsonPropertyName("projectInputHistory")] public List<string>? ProjectInputHistory { get; init; }
    [JsonPropertyName("todos")] public List<TodoItem>? Todos { get; init; }
    [JsonPropertyName("readFileTimestamps")] public Dictionary<string, long>? ReadFileTimestamps { get; init; }
}

public record StateUpdateData
{
    [JsonPropertyName("state")] public AppSessionState? State { get; init; }
}

public record TaskAgentEndData
{
    [JsonPropertyName("taskId")] public string? TaskId { get; init; }
    [JsonPropertyName("status")] public string? Status { get; init; }
    [JsonPropertyName("content")] public string? Content { get; init; }
}

public record TaskAgentStartData
{
    [JsonPropertyName("taskId")] public string? TaskId { get; init; }
    [JsonPropertyName("agent_type")] public string? AgentType { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("instructions")] public string? Instructions { get; init; }
    [JsonPropertyName("background")] public bool Background { get; init; }
}

public record TaskEndData
{
    [JsonPropertyName("taskId")] public string? TaskId { get; init; }
    [JsonPropertyName("status")] public string? Status { get; init; }
    [JsonPropertyName("summary")] public string? Summary { get; init; }
}

public record TaskStartData
{
    [JsonPropertyName("taskId")] public string? TaskId { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    [JsonPropertyName("filepath")] public string? Filepath { get; init; }
    [JsonPropertyName("status")] public CronTaskStatus? Status { get; init; }
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("pid")] public long? Pid { get; init; }
    [JsonPropertyName("agentType")] public string? AgentType { get; init; }
}

public record TaskTransferData
{
    [JsonPropertyName("taskId")] public string? TaskId { get; init; }
    [JsonPropertyName("command")] public string? Command { get; init; }
    [JsonPropertyName("filepath")] public string? Filepath { get; init; }
    [JsonPropertyName("status")] public CronTaskStatus? Status { get; init; }
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("pid")] public long? Pid { get; init; }
    [JsonPropertyName("agentType")] public string? AgentType { get; init; }
}

public record TaskWatchDeltaData
{
    [JsonPropertyName("taskId")] public string? TaskId { get; init; }
    [JsonPropertyName("delta")] public string? Delta { get; init; }
}

public record TextChunkData
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("delta")] public string? Delta { get; init; }
}

public record TextQuestion : PickOptionQuestion
{
    [JsonPropertyName("required")] public bool? Required { get; init; }
    [JsonPropertyName("placeholder")] public string? Placeholder { get; init; }
    [JsonIgnore] public override string Type => "text";
}

public record TextareaQuestion : PickOptionQuestion
{
    [JsonPropertyName("required")] public bool? Required { get; init; }
    [JsonPropertyName("placeholder")] public string? Placeholder { get; init; }
    [JsonIgnore] public override string Type => "textarea";
}

public record ThinkingChunkData
{
    [JsonPropertyName("id")] public string? Id { get; init; }
    [JsonPropertyName("delta")] public string? Delta { get; init; }
}

public record ToolExecutionChunkData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("toolId")] public string? ToolId { get; init; }
    [JsonPropertyName("toolName")] public string? ToolName { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("summary")] public string? Summary { get; init; }
    [JsonPropertyName("content")] public JsonElement? Content { get; init; }
}

public record ToolExecutionCompleteData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("toolId")] public string? ToolId { get; init; }
    [JsonPropertyName("toolName")] public string? ToolName { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("summary")] public string? Summary { get; init; }
    [JsonPropertyName("content")] public JsonElement? Content { get; init; }
}

public record ToolExecutionErrorData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("toolName")] public string? ToolName { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("content")] public string? Content { get; init; }
    [JsonPropertyName("toolId")] public string? ToolId { get; init; }
    [JsonPropertyName("input")] public Dictionary<string, JsonElement>? Input { get; init; }
}

public record ToolPermissionAutoData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("toolId")] public string? ToolId { get; init; }
    [JsonPropertyName("toolName")] public string? ToolName { get; init; }
    [JsonPropertyName("content")] public string? Content { get; init; }
}

public record ToolPermissionRequestData
{
    [JsonPropertyName("agentId")] public string? AgentId { get; init; }
    [JsonPropertyName("toolId")] public string? ToolId { get; init; }
    [JsonPropertyName("toolName")] public string? ToolName { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
    [JsonPropertyName("content")] public JsonElement? Content { get; init; }
    [JsonPropertyName("options")] public Dictionary<string, string>? Options { get; init; }
}

public record ToolPermissionResponse
{
    [JsonPropertyName("toolId")] public string? ToolId { get; init; }
    [JsonPropertyName("toolName")] public string? ToolName { get; init; }
    [JsonPropertyName("selected")] public string? Selected { get; init; }
}

public record TopicUpdateData
{
    [JsonPropertyName("isNewTopic")] public bool IsNewTopic { get; init; }
    [JsonPropertyName("title")] public string? Title { get; init; }
}

public record Usage
{
    [JsonPropertyName("useTokens")] public long UseTokens { get; init; }
    [JsonPropertyName("maxTokens")] public long MaxTokens { get; init; }
    [JsonPropertyName("promptTokens")] public long PromptTokens { get; init; }
}

public record quickchatResponseData
{
    [JsonPropertyName("question")] public string? Question { get; init; }
    [JsonPropertyName("content")] public string? Content { get; init; }
}

/// <summary>todos:update 事件数据（≙ core TodosUpdateData = TodoItem[]；payload 即数组）。</summary>
public sealed class TodosUpdateData : List<TodoItem>;

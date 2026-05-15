using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace SemaDemo;

/// <summary>
/// sema-core C# 客户端
/// 通过 WebSocket 连接桥接服务，提供与 sema-core 的全双工通信能力
/// </summary>
public class SemaCoreClient : IAsyncDisposable
{
    private readonly ClientWebSocket _ws = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly JsonSerializerSettings _jsonSettings = new()
    {
        NullValueHandling = NullValueHandling.Ignore
    };

    // 等待 ack 的 TaskCompletionSource：cmdId -> TCS
    private readonly ConcurrentDictionary<string, TaskCompletionSource<BridgeEvent>> _pending = new();

    // 事件处理器注册表：eventName -> handlers
    private readonly ConcurrentDictionary<string, List<Action<JToken?>>> _handlers = new();

    // ── 事件订阅 ──────────────────────────────────────────────────

    /// <summary>
    /// 注册事件处理器
    /// </summary>
    public void On(string eventName, Action<JToken?> handler)
    {
        _handlers.GetOrAdd(eventName, _ => []).Add(handler);
    }

    /// <summary>
    /// 注册一次性事件处理器（触发后自动注销）
    /// </summary>
    public void Once(string eventName, Action<JToken?> handler)
    {
        Action<JToken?>? wrapper = null;
        wrapper = data =>
        {
            handler(data);
            if (_handlers.TryGetValue(eventName, out var list))
                list.Remove(wrapper!);
        };
        _handlers.GetOrAdd(eventName, _ => []).Add(wrapper);
    }

    // ── 连接 ──────────────────────────────────────────────────────

    /// <summary>
    /// 连接到 sema-bridge 桥接服务
    /// </summary>
    public async Task ConnectAsync(string url)
    {
        await _ws.ConnectAsync(new Uri(url), _cts.Token);
        _ = ReceiveLoopAsync();
    }

    // ── 接收循环 ──────────────────────────────────────────────────

    private async Task ReceiveLoopAsync()
    {
        var buffer = new byte[64 * 1024];

        while (_ws.State == WebSocketState.Open)
        {
            try
            {
                var sb = new StringBuilder();
                WebSocketReceiveResult result;

                // 支持分片消息
                do
                {
                    result = await _ws.ReceiveAsync(buffer, _cts.Token);
                    sb.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                }
                while (!result.EndOfMessage);

                if (result.MessageType == WebSocketMessageType.Close)
                    break;

                var evt = JsonConvert.DeserializeObject<BridgeEvent>(sb.ToString());
                if (evt == null)
                    continue;

                // 处理指令响应（ack / error with cmdId）
                if (evt.CmdId != null && _pending.TryRemove(evt.CmdId, out var tcs))
                {
                    if (evt.Event == "error")
                        tcs.SetException(new Exception(
                            evt.Data?["message"]?.ToString() ?? "Unknown error"));
                    else
                        tcs.SetResult(evt);
                }

                // 分发推送事件给订阅的处理器（快照避免 Once 移除时并发修改）
                if (_handlers.TryGetValue(evt.Event, out var handlers))
                    foreach (var h in handlers.ToList())
                        h(evt.Data);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[SemaCoreClient] Receive error: {ex.Message}");
                break;
            }
        }
    }

    // ── 发送指令 ──────────────────────────────────────────────────

    /// <summary>
    /// 发送指令并等待响应（ack 或 error）
    /// </summary>
    public async Task<BridgeEvent> SendCommandAsync(string action, object? payload = null, int timeoutMs = 15000)
    {
        var cmd = new BridgeCommand(action, payload);
        var tcs = new TaskCompletionSource<BridgeEvent>();
        _pending[cmd.Id] = tcs;

        var json = JsonConvert.SerializeObject(cmd, _jsonSettings);
        var bytes = Encoding.UTF8.GetBytes(json);
        await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, _cts.Token);

        using var timeoutCts = new CancellationTokenSource(timeoutMs);
        timeoutCts.Token.Register(() => tcs.TrySetCanceled(), useSynchronizationContext: false);

        return await tcs.Task;
    }

    // ── 高级封装 API ──────────────────────────────────────────────

    /// <summary>创建或恢复会话</summary>
    public Task CreateSessionAsync(string? sessionId = null) =>
        SendCommandAsync("session.create", sessionId != null ? new { sessionId } : null);

    /// <summary>发送用户消息</summary>
    public Task SendUserInputAsync(string content, string? orgContent = null) =>
        SendCommandAsync("session.input", new { content, orgContent });

    /// <summary>中断当前处理</summary>
    public Task InterruptAsync() =>
        SendCommandAsync("session.interrupt");

    /// <summary>响应工具权限请求</summary>
    public Task RespondToPermissionAsync(string toolId, string toolName, string selected) =>
        SendCommandAsync("permission.respond", new { toolId, toolName, selected });

    /// <summary>响应问答请求</summary>
    public Task RespondToQuestionAsync(string agentId, Dictionary<string, string> answers) =>
        SendCommandAsync("question.respond", new { agentId, answers });

    /// <summary>响应计划退出请求</summary>
    public Task RespondToPlanExitAsync(string agentId, string selected) =>
        SendCommandAsync("plan.respond", new { agentId, selected });

    /// <summary>添加模型</summary>
    public Task AddModelAsync(object config, bool skipValidation = false) =>
        SendCommandAsync("model.add", new { config, skipValidation });

    /// <summary>应用任务模型配置（main / quick 使用的模型 ID）</summary>
    public Task ApplyTaskModelAsync(string main, string quick) =>
        SendCommandAsync("model.applyTask", new { main, quick });

    /// <summary>删除模型</summary>
    public Task DelModelAsync(string modelName) =>
        SendCommandAsync("model.del", new { modelName });

    /// <summary>切换模型</summary>
    public Task SwitchModelAsync(string modelName) =>
        SendCommandAsync("model.switch", new { modelName });

    /// <summary>获取模型信息</summary>
    public Task GetModelDataAsync() =>
        SendCommandAsync("model.getData");

    /// <summary>设置代理模式（Agent / Plan）</summary>
    public Task SetAgentModeAsync(string mode) =>
        SendCommandAsync("config.updateAgentMode", new { mode });

    /// <summary>
    /// 初始化核心配置（在 CreateSession 之前调用）。
    /// 会以新配置重建底层 SemaCore 实例，workingDir 等构造函数级别的选项在此生效。
    /// </summary>
    public Task InitCoreAsync(SemaCoreConfig config) =>
        SendCommandAsync("config.init", config);

    /// <summary>更新运行时配置（会话创建后也可调用）</summary>
    public Task UpdateConfigAsync(object config) =>
        SendCommandAsync("config.update", config);

    /// <summary>销毁会话</summary>
    public Task DisposeSessionAsync() =>
        SendCommandAsync("session.dispose");

    // ── 释放 ──────────────────────────────────────────────────────

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();

        if (_ws.State == WebSocketState.Open)
        {
            try
            {
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", default);
            }
            catch
            {
                // 关闭时忽略错误
            }
        }

        _ws.Dispose();
        _cts.Dispose();
    }
}

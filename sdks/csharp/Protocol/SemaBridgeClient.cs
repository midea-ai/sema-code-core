using System.Collections.Concurrent;
using System.Text.Json;
using Semacore.Transport;

namespace Semacore.Protocol;

/// <summary>桥事件监听器（协议层：已按事件名 / 会话过滤；≙ Java protocol/EventListener）。</summary>
/// <param name="dataJson">事件 data（JSON 字符串，可为空字符串）</param>
/// <param name="sessionId">事件所属会话 ID（进程级事件为空字符串）</param>
public delegate void EventListener(string dataJson, string sessionId);

/// <summary>
/// sema-grpc 桥的协议层客户端：在 <see cref="BridgeConnection"/> 之上提供指令/响应匹配与事件订阅
/// （镜像 Java protocol/SemaBridgeClient）。
///
/// <list type="bullet">
///   <item><see cref="Call"/>：发指令并返回 Task；桥回 ack → 以 data 完成，回 error →
///     以 <see cref="SemaBridgeException"/> 异常完成。payload / data 均为 JSON 字符串（薄客户端不定义类型）。</item>
///   <item><see cref="On(string, EventListener)"/> / <see cref="Once(string, EventListener)"/> /
///     <see cref="WaitFor"/>：按事件名（可选按 sessionId）订阅桥推送事件。</item>
///   <item>连接断开（重连中 / 已关闭）时，所有在途 Call 立即以异常完成——流断开后桥侧响应已不可达，
///     上层应在重连成功后自行决定是否重放。</item>
///   <item>指令 Task 的续体与事件回调都在连接读循环上同步执行（≙ Java 语义），
///     回调 / <c>await</c> 后的续体内绝不能同步阻塞等待本连接的响应（<c>.Wait()</c> / <c>.Result</c> 会死锁）。</item>
///   <item>协议逻辑在别处（如 webview JS）的哑转发宿主不需要本类，直接用 <see cref="BridgeConnection"/>。</item>
/// </list>
/// </summary>
public sealed class SemaBridgeClient : IAsyncDisposable
{
    private readonly BridgeConnection _connection;
    private readonly ConcurrentDictionary<string, PendingCall> _pendingCalls = new();
    private readonly ConcurrentDictionary<string, List<Subscription>> _subscriptions = new();
    private readonly List<Action<SemaEvent>> _anyListeners = new();

    private sealed record PendingCall(string Action, TaskCompletionSource<string> Tcs);

    private sealed class Subscription
    {
        public Subscription(string? sessionFilter, bool once, EventListener listener)
        {
            SessionFilter = sessionFilter;
            Once = once;
            Listener = listener;
        }

        public string? SessionFilter { get; }
        public bool Once { get; }
        public EventListener Listener { get; }
    }

    /// <summary>包装一条连接（不代为 Connect；宿主自行控制建连时机）。</summary>
    public SemaBridgeClient(BridgeConnection connection)
    {
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        connection.OnEvent(Dispatch);
        connection.OnStateChange((state, error) =>
        {
            if (state is ConnectionState.Reconnecting or ConnectionState.Closed)
                FailPendingCalls(state, error);
        });
    }

    /// <summary>底层连接（注册状态监听、哑转发等场景用）。</summary>
    public BridgeConnection Connection => _connection;

    // ── 指令 ─────────────────────────────────────────────────────────────

    /// <summary>
    /// 发送指令并等待响应。
    /// </summary>
    /// <param name="action">操作名（与 sema-core 方法名一一对应）</param>
    /// <param name="payloadJson">JSON 序列化的参数，可为 null</param>
    /// <param name="sessionId">目标会话 ID；进程级 action 传空</param>
    /// <returns>ack 的 data（JSON 字符串，可能为空字符串）。桥回 error / 连接断开时异常完成。
    /// 需要超时的调用方自行 <c>task.WaitAsync(...)</c>。</returns>
    public Task<string> Call(string action, string? payloadJson = null, string sessionId = "")
    {
        var id = Guid.NewGuid().ToString();
        var tcs = new TaskCompletionSource<string>();
        _pendingCalls[id] = new PendingCall(action, tcs);
        _ = SendAsync(id, action, payloadJson, sessionId, tcs);
        return tcs.Task;
    }

    private async Task SendAsync(string id, string action, string? payloadJson, string sessionId,
        TaskCompletionSource<string> tcs)
    {
        try
        {
            await _connection.Send(id, action, payloadJson, sessionId).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            if (_pendingCalls.TryRemove(id, out _)) tcs.TrySetException(e);
        }
    }

    // ── 事件订阅 ─────────────────────────────────────────────────────────

    /// <summary>订阅事件（所有会话 + 进程级）。</summary>
    public Registration On(string @event, EventListener listener) => Subscribe(@event, null, false, listener);

    /// <summary>订阅指定会话的事件（sessionId 精确匹配；进程级事件传 ""）。</summary>
    public Registration On(string @event, string sessionId, EventListener listener)
        => Subscribe(@event, sessionId ?? throw new ArgumentNullException(nameof(sessionId)), false, listener);

    /// <summary>一次性订阅（触发后自动注销）。</summary>
    public Registration Once(string @event, EventListener listener) => Subscribe(@event, null, true, listener);

    /// <summary>一次性订阅指定会话的事件。</summary>
    public Registration Once(string @event, string sessionId, EventListener listener)
        => Subscribe(@event, sessionId ?? throw new ArgumentNullException(nameof(sessionId)), true, listener);

    /// <summary>等待事件触发一次并返回其 data。</summary>
    /// <param name="sessionId">精确匹配的会话 ID；null 表示任意</param>
    /// <param name="timeout">超时时长；null 表示不超时</param>
    public async Task<string> WaitFor(string @event, string? sessionId = null, TimeSpan? timeout = null)
    {
        var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var reg = Subscribe(@event, sessionId, true, (data, _) => tcs.TrySetResult(data));
        try
        {
            return timeout is { } t
                ? await tcs.Task.WaitAsync(t).ConfigureAwait(false)
                : await tcs.Task.ConfigureAwait(false);
        }
        finally
        {
            reg.Unregister(); // 超时/取消时清掉订阅
        }
    }

    /// <summary>订阅所有推送事件（已排除被 Call 消费的 ack/error 响应帧）；调试 / 全量转发用。</summary>
    public Registration OnAny(Action<SemaEvent> listener)
    {
        ArgumentNullException.ThrowIfNull(listener);
        lock (_anyListeners) _anyListeners.Add(listener);
        return new Registration(() =>
        {
            lock (_anyListeners) _anyListeners.Remove(listener);
        });
    }

    /// <summary>关闭底层连接。</summary>
    public Task Close() => _connection.Close();

    public ValueTask DisposeAsync() => new(Close());

    // ── 内部 ─────────────────────────────────────────────────────────────

    private Registration Subscribe(string @event, string? sessionFilter, bool once, EventListener listener)
    {
        ArgumentNullException.ThrowIfNull(@event);
        ArgumentNullException.ThrowIfNull(listener);
        var list = _subscriptions.GetOrAdd(@event, _ => new List<Subscription>());
        var sub = new Subscription(sessionFilter, once, listener);
        lock (list) list.Add(sub);
        return new Registration(() =>
        {
            lock (list) list.Remove(sub);
        });
    }

    private void Dispatch(SemaEvent evt)
    {
        // 1) 响应帧：按 cmdId 匹配在途 Call；匹配上即消费，不再进入事件分发。
        //    TCS 用默认（同步）续体：与 Java「ack 分发链上同步执行」语义一致，
        //    createSession 后紧跟的 session:ready 订阅因此必不丢失
        if (evt.IsResponse)
        {
            if (_pendingCalls.TryRemove(evt.CmdId, out var call))
            {
                if (evt.Event == "error")
                    call.Tcs.TrySetException(ToException(call.Action, evt.Data));
                else
                    call.Tcs.TrySetResult(evt.Data);
                return;
            }
        }

        // 2) 推送事件：全量监听 + 按事件名/会话过滤的订阅
        Action<SemaEvent>[] any;
        lock (_anyListeners) any = _anyListeners.ToArray();
        foreach (var l in any)
        {
            try { l(evt); } catch { }
        }
        if (!_subscriptions.TryGetValue(evt.Event, out var list)) return;
        Subscription[] subs;
        lock (list) subs = list.ToArray();
        foreach (var sub in subs)
        {
            if (sub.SessionFilter != null && sub.SessionFilter != evt.SessionId) continue;
            if (sub.Once)
            {
                lock (list)
                {
                    if (!list.Remove(sub)) continue; // 已被并发消费/注销
                }
            }
            try
            {
                sub.Listener(evt.Data, evt.SessionId);
            }
            catch
            {
                // 单个监听器异常不影响其他监听器
            }
        }
    }

    private void FailPendingCalls(ConnectionState state, Exception? error)
    {
        var reason = state == ConnectionState.Closed ? "连接已关闭" : "连接断开（重连中），响应已不可达";
        foreach (var id in _pendingCalls.Keys)
        {
            if (_pendingCalls.TryRemove(id, out var call))
                call.Tcs.TrySetException(new SemaBridgeException(call.Action, reason, error));
        }
    }

    private static SemaBridgeException ToException(string action, string dataJson)
    {
        var message = dataJson;
        try
        {
            using var doc = JsonDocument.Parse(dataJson);
            if (doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("message", out var m)
                && m.ValueKind == JsonValueKind.String)
            {
                message = m.GetString();
            }
        }
        catch (JsonException)
        {
            // data 不是 JSON 对象时原样作为 message
        }
        return new SemaBridgeException(action, string.IsNullOrEmpty(message) ? "Unknown error" : message);
    }
}

using System.Text.Json;
using Semacore.Events;
using Semacore.Protocol;
using Semacore.Types;

namespace Semacore;

/// <summary>
/// sema-core 会话的镜像 API：用法与 Node 侧 <c>const session = await core.createSession()</c> 一致
/// （≙ Java semacore.SemaSession）。
///
/// <para>方法名/参数名 = core 的 SemaSession；入参/返回值 = 强类型 DTO；事件名 = core 原始事件名
/// （<c>session:ready</c> / <c>message:text:chunk</c> / ...，裸字符串订阅），<see cref="On"/> 自动按
/// 本会话 sessionId 过滤，回调 data 为 <see cref="JsonElement"/>。镜像原则见 <see cref="SemaCore"/>。</para>
///
/// <para><b>创建期事件语义</b>：会话对象构造时（ack 分发链上）即捕获 <c>session:ready</c> 并缓存，
/// 之后（含晚）订阅立即重放，保证 Node 式「createSession 后再订阅」不丢事件。</para>
/// </summary>
public sealed class SemaSession
{
    private readonly SemaBridgeClient _client;
    private readonly string _sessionId;
    private readonly TaskCompletionSource<JsonElement?> _ready = new();
    private readonly List<(string Event, Action<JsonElement?> Handler, Registration Reg)> _subs = new();

    internal SemaSession(SemaBridgeClient client, string sessionId)
    {
        _client = client;
        _sessionId = sessionId;
        // 构造发生在 createSession ack 的分发链上，早于桥推送 session:ready（同一 gRPC 流串行分发），
        // 故此处订阅必不丢失；对 Session(sessionId) 拿到的旧会话句柄，该事件已成历史，ready 永不完成（与 Node 一致）。
        client.Once("session:ready", sessionId, (data, _) => _ready.TrySetResult(Json.Parse(data)));
    }

    public string SessionId => _sessionId;

    // ── 会话交互 ─────────────────────────────────────────────────────────

    /// <summary>发送用户输入（回复经事件流推送；ack 仅送达确认）。形参名对齐 core（input / originalInput）。</summary>
    public Task ProcessUserInput(string input, string? originalInput = null,
        List<InputImageAttachment>? attachments = null)
        => VoidCall("processUserInput",
            Json.Obj(("content", input), ("orgContent", originalInput), ("attachments", attachments)));

    public Task Interrupt()
        => VoidCall("interrupt", null);

    // ── 交互应答 ─────────────────────────────────────────────────────────

    /// <summary>应答 <c>tool:permission:request</c>。</summary>
    public Task RespondToToolPermission(ToolPermissionResponse response)
        => VoidCall("respondToToolPermission", response);

    /// <summary>应答 <c>pick:option:request</c>。</summary>
    public Task RespondToPickOption(PickOptionResponseData response)
        => VoidCall("respondToPickOption", response);

    /// <summary>应答 <c>plan:exit:request</c>。</summary>
    public Task RespondToPlanExit(PlanExitResponseData response)
        => VoidCall("respondToPlanExit", response);

    // ── 模式 / 权限 ──────────────────────────────────────────────────────

    public Task UpdateAgentMode(AgentMode mode)
        => VoidCall("updateAgentMode", Json.Obj(("mode", mode)));

    public Task UpdatePermissionLevel(PermissionLevel level)
        => VoidCall("updatePermissionLevel", Json.Obj(("level", level)));

    // ── fork / 撤销回退 ──────────────────────────────────────────────────

    public async Task<ForkPreview?> GetForkPreview(string messageUuid)
        => Json.To<ForkPreview>(await Req("getForkPreview", Json.Obj(("messageUuid", messageUuid))).ConfigureAwait(false));

    public async Task<ForkResult?> Fork(string messageUuid, ForkOptions? options = null)
    {
        var el = await Req("fork", Json.Obj(("messageUuid", messageUuid), ("options", options))).ConfigureAwait(false);
        if (el == null) return null;
        // 判别联合按 ok 分派到具体变体（≙ core ForkResult；判别符是 bool，STJ 多态不支持，手动分派）
        return SemaJson.Bool(el, "ok", false)
            ? Json.To<ForkResultOk>(el)
            : Json.To<ForkResultErr>(el);
    }

    // ── 后台任务（会话级）────────────────────────────────────────────────

    public async Task<List<TaskListItem>> GetTaskList()
        => Json.ToList<TaskListItem>(await Req("getTaskList", null).ConfigureAwait(false));

    /// <summary>停掉本会话全部后台子 agent；返回停掉数量。</summary>
    public async Task<int> StopAllTasks()
        => SemaJson.I32(await Req("stopAllTasks", null).ConfigureAwait(false), "count", 0);

    public async Task<bool> StopTask(string taskId)
        => SemaJson.Bool(await Req("stopTask", Json.Obj(("taskId", taskId))).ConfigureAwait(false), "ok", false);

    public async Task<bool> TransferAgentToBackground(string taskId)
        => SemaJson.Bool(await Req("transferAgentToBackground", Json.Obj(("taskId", taskId))).ConfigureAwait(false), "ok", false);

    public async Task<List<string>> TransferAllForegroundAgents()
        => Json.ToList<string>(SemaJson.Get(await Req("transferAllForegroundAgents", null).ConfigureAwait(false), "taskIds"));

    /// <summary>开始流式观察任务输出；注销返回的 Registration 会停止观察并退订事件。</summary>
    public Registration WatchTask(string taskId, Action<string> onDelta)
    {
        ArgumentNullException.ThrowIfNull(taskId);
        ArgumentNullException.ThrowIfNull(onDelta);
        var registration = _client.On("task:watch:delta", _sessionId, (data, _) =>
        {
            var element = Json.Parse(data);
            if (SemaJson.Str(element, "taskId") != taskId) return;
            var delta = SemaJson.Str(element, "delta");
            if (delta != null) onDelta(delta);
        });
        _ = VoidCall("watchTask", Json.Obj(("taskId", taskId)));
        return new Registration(() =>
        {
            registration.Unregister();
            _ = VoidCall("unwatchTask", Json.Obj(("taskId", taskId)));
        });
    }

    // ── 事件（core 原始事件名，自动按本会话过滤）─────────────────────────

    public Registration On(string @event, Action<JsonElement?> handler)
    {
        if (@event == "session:ready") return SubscribeReady(handler);
        var reg = _client.On(@event, _sessionId, (data, _) => handler(Json.Parse(data)));
        _subs.Add((@event, handler, reg));
        return reg;
    }

    public Registration Once(string @event, Action<JsonElement?> handler)
    {
        if (@event == "session:ready") return SubscribeReady(handler);
        var reg = _client.Once(@event, _sessionId, (data, _) => handler(Json.Parse(data)));
        _subs.Add((@event, handler, reg));
        return reg;
    }

    /// <summary>按 (event, handler) 取消订阅（≙ Node off）；移除首个匹配的 On/Once 注册。</summary>
    public void Off(string @event, Action<JsonElement?> handler)
    {
        for (var i = 0; i < _subs.Count; i++)
        {
            if (_subs[i].Event == @event && ReferenceEquals(_subs[i].Handler, handler))
            {
                _subs[i].Reg.Unregister();
                _subs.RemoveAt(i);
                return;
            }
        }
    }

    /// <summary>等待本会话某事件触发一次（可选 predicate 对解析后的 data 过滤）；timeout 为 null 表示不超时。</summary>
    public async Task<JsonElement?> WaitFor(string @event, TimeSpan? timeout = null,
        Func<JsonElement?, bool>? predicate = null)
    {
        if (@event == "session:ready" && _ready.Task is { IsCompletedSuccessfully: true } done)
        {
            var cached = done.Result;
            if (predicate == null || predicate(cached)) return cached;
        }
        var future = new TaskCompletionSource<JsonElement?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var reg = @event == "session:ready"
            ? SubscribeReady(Complete)
            : _client.On(@event, _sessionId, (data, _) => Complete(Json.Parse(data)));
        try
        {
            return timeout is { } t
                ? await future.Task.WaitAsync(t).ConfigureAwait(false)
                : await future.Task.ConfigureAwait(false);
        }
        finally
        {
            reg.Unregister();
        }

        void Complete(JsonElement? d)
        {
            if (predicate == null || predicate(d)) future.TrySetResult(d);
        }
    }

    /// <summary>session:ready 走缓存重放（本质一次性事件，On/Once 等价）。</summary>
    private Registration SubscribeReady(Action<JsonElement?> handler)
    {
        var active = true;
        _ready.Task.ContinueWith(t =>
        {
            if (active && t.IsCompletedSuccessfully) handler(t.Result);
        }, TaskContinuationOptions.ExecuteSynchronously);
        return new Registration(() => active = false);
    }

    // ── 生命周期 ─────────────────────────────────────────────────────────

    /// <summary>关闭本会话（≙ core.closeSession；只关会话不关连接）。</summary>
    public async Task<bool> Close()
    {
        var ack = Json.Parse(await _client.Call("closeSession", null, _sessionId).ConfigureAwait(false));
        return SemaJson.Bool(ack, "ok", false);
    }

    // ── 内部 ─────────────────────────────────────────────────────────────

    private async Task<JsonElement?> Req(string action, object? payload)
        => Json.Parse(await _client.Call(action, Json.Stringify(payload), _sessionId).ConfigureAwait(false));

    /// <summary>Node void 语义：等 ack 送达即完成（纯送达确认，无返回数据）。</summary>
    private Task VoidCall(string action, object? payload)
        => _client.Call(action, Json.Stringify(payload), _sessionId);
}

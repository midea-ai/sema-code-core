using Grpc.Core;
using Grpc.Net.Client;
using Sema.Sdk.Internal.Grpc;

namespace Semacore.Transport;

/// <summary>
/// sema-grpc 桥的传输层连接：一条 gRPC 双向流（镜像 Java transport/BridgeConnection）。
///
/// <list type="bullet">
///   <item><b>就绪前缓冲</b>：<see cref="Connect"/> 后即可 <see cref="Send"/>，连接就绪前指令入队，
///     就绪后按序 flush（消除「指令早于连接就绪」竞态）。</item>
///   <item><b>断线重连</b>：流断开后按指数退避自动重连（250ms 起、封顶 10s，默认开启、无限次）；
///     重连成功回到 <see cref="ConnectionState.Connected"/>。注意：桥的会话绑定是连接级状态，
///     重连后原会话事件不会自动续流，需上层重新 attach。</item>
///   <item><b>多连接</b>：同一 sidecar 可开任意多条 BridgeConnection（各自独立 cmdId 空间、事件流互不串扰；
///     进程级事件每条连接都会收到）。</item>
///   <item><b>线程模型</b>：事件/状态监听器在连接的读循环上同步执行（≙ Java 的 gRPC 分发线程），
///     回调内不要做耗时操作，绝不能同步阻塞等待本连接上的响应（如 <c>.Wait()</c> / <c>.Result</c>）。</item>
/// </list>
/// </summary>
public sealed class BridgeConnection : IAsyncDisposable
{
    /// <summary>默认单条消息上限 64MB：贴图 / 大 diff 场景下 4MB 默认值会超限断连。</summary>
    public const int DefaultMaxInboundMessageSize = 64 * 1024 * 1024;

    private readonly string _host;
    private readonly Task<int> _portTask;
    private readonly int _maxInbound;
    private readonly bool _reconnectEnabled;
    private readonly TimeSpan _initialBackoff;
    private readonly TimeSpan _maxBackoff;
    private readonly int _maxAttempts; // <=0 表示无限次

    private readonly List<Action<SemaEvent>> _eventListeners = new();
    private readonly List<Action<ConnectionState, Exception?>> _stateListeners = new();
    /// <summary>串行化写入：RequestStream.WriteAsync 不允许并发；缓冲队列同受此闸保护。</summary>
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly Queue<BridgeCommand> _pending = new();
    private readonly CancellationTokenSource _cts = new();
    private readonly object _connectLock = new();

    private IClientStreamWriter<BridgeCommand>? _requests; // guarded by _writeGate
    private bool _streamReady;                             // guarded by _writeGate
    private Task? _runner;
    private volatile ConnectionState _state = ConnectionState.Connecting;
    private volatile bool _closed;

    /// <param name="port">固定端口，与 <paramref name="portTask"/> 二选一</param>
    /// <param name="portTask">端口异步就绪（如等待 SidecarManager 启动完成）；Connect 后指令先入缓冲，端口就绪再建连</param>
    /// <param name="host">桥地址，默认 127.0.0.1</param>
    /// <param name="maxInboundMessageSize">单条入站消息上限，默认 64MB</param>
    /// <param name="reconnectEnabled">是否自动重连，默认 true</param>
    /// <param name="reconnectInitialBackoff">重连退避起点，默认 250ms（指数翻倍）</param>
    /// <param name="reconnectMaxBackoff">重连退避封顶，默认 10s</param>
    /// <param name="reconnectMaxAttempts">最大重连次数，&lt;=0 表示无限次（默认）；耗尽后进入 Closed</param>
    public BridgeConnection(
        int? port = null,
        Task<int>? portTask = null,
        string host = "127.0.0.1",
        int maxInboundMessageSize = DefaultMaxInboundMessageSize,
        bool reconnectEnabled = true,
        TimeSpan? reconnectInitialBackoff = null,
        TimeSpan? reconnectMaxBackoff = null,
        int reconnectMaxAttempts = 0)
    {
        if (port is null && portTask is null)
            throw new ArgumentException("port 与 portTask 必须提供其一");
        _host = host;
        _portTask = portTask ?? Task.FromResult(port!.Value);
        _maxInbound = maxInboundMessageSize;
        _reconnectEnabled = reconnectEnabled;
        _initialBackoff = reconnectInitialBackoff ?? TimeSpan.FromMilliseconds(250);
        _maxBackoff = reconnectMaxBackoff ?? TimeSpan.FromSeconds(10);
        _maxAttempts = reconnectMaxAttempts;
    }

    // ── 公共 API ──────────────────────────────────────────────────────────

    /// <summary>注册事件监听（收到桥推送的所有帧，含 ack / error）。可在 Connect 前后任意时刻调用。</summary>
    public void OnEvent(Action<SemaEvent> listener)
    {
        ArgumentNullException.ThrowIfNull(listener);
        lock (_eventListeners) _eventListeners.Add(listener);
    }

    /// <summary>注册连接状态监听（参数为新状态与触发异常，正常变化为 null）。</summary>
    public void OnStateChange(Action<ConnectionState, Exception?> listener)
    {
        ArgumentNullException.ThrowIfNull(listener);
        lock (_stateListeners) _stateListeners.Add(listener);
    }

    /// <summary>当前连接状态。</summary>
    public ConnectionState State => _state;

    /// <summary>启动连接（异步、幂等）。等待端口就绪 → 建 channel → 开双向流；期间的 Send 全部入缓冲队列。</summary>
    public void Connect()
    {
        if (_closed) throw new InvalidOperationException("连接已关闭");
        lock (_connectLock)
        {
            _runner ??= Task.Run(RunAsync);
        }
    }

    /// <summary>
    /// 发送一帧指令（哑转发：payload 为 JSON 字符串，SDK 不解释内容）。
    /// 连接未就绪 / 重连中时入缓冲队列，就绪后按序发出。
    /// </summary>
    /// <param name="id">请求 ID（响应帧以 cmdId 回带）</param>
    /// <param name="action">操作名（与 sema-core 方法名一一对应）</param>
    /// <param name="payload">JSON 序列化的参数，可为 null / 空</param>
    /// <param name="sessionId">目标会话 ID；进程级 action 传空</param>
    public async Task Send(string id, string action, string? payload, string? sessionId)
    {
        if (_closed) throw new InvalidOperationException("连接已关闭");
        var cmd = new BridgeCommand
        {
            Id = id ?? "",
            Action = action ?? "",
            Payload = payload ?? "",
            SessionId = sessionId ?? "",
        };
        await _writeGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_streamReady && _requests != null)
            {
                try
                {
                    await _requests.WriteAsync(cmd).ConfigureAwait(false);
                    return;
                }
                catch
                {
                    // 流刚好断开：转入缓冲，等待重连后补发
                }
            }
            if (_closed) throw new InvalidOperationException("连接已关闭");
            _pending.Enqueue(cmd);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    /// <summary>关闭连接并释放资源；不可再复用。</summary>
    public async Task Close()
    {
        if (_closed) return;
        _closed = true;
        _cts.Cancel();
        var runner = _runner;
        if (runner != null)
        {
            try { await runner.ConfigureAwait(false); } catch { }
        }
        SetState(ConnectionState.Closed, null);
    }

    public ValueTask DisposeAsync() => new(Close());

    // ── 建连 / 重连主循环（≙ Python transport 的 _run） ──────────────────

    private async Task RunAsync()
    {
        int port;
        try
        {
            port = await _portTask.WaitAsync(_cts.Token).ConfigureAwait(false);
        }
        catch (Exception e)
        {
            _closed = true;
            SetState(ConnectionState.Closed, e is OperationCanceledException ? null : e);
            return;
        }

        var attempt = 0;
        while (!_closed)
        {
            Exception? err = null;
            GrpcChannel? channel = null;
            AsyncDuplexStreamingCall<BridgeCommand, BridgeEvent>? call = null;
            try
            {
                channel = GrpcChannel.ForAddress($"http://{_host}:{port}", new GrpcChannelOptions
                {
                    MaxReceiveMessageSize = _maxInbound,
                });
                // 等 channel READY 再宣告 CONNECTED / flush 缓冲，避免把缓冲指令灌进注定失败的流
                using (var readyCts = CancellationTokenSource.CreateLinkedTokenSource(_cts.Token))
                {
                    readyCts.CancelAfter(TimeSpan.FromSeconds(10));
                    await channel.ConnectAsync(readyCts.Token).ConfigureAwait(false);
                }
                var stub = new SemaBridge.SemaBridgeClient(channel);
                call = stub.Connect(cancellationToken: _cts.Token);

                await _writeGate.WaitAsync(_cts.Token).ConfigureAwait(false);
                try
                {
                    _requests = call.RequestStream;
                    _streamReady = true;
                    while (_pending.Count > 0) // 按序 flush 就绪前缓冲
                    {
                        await call.RequestStream.WriteAsync(_pending.Peek()).ConfigureAwait(false);
                        _pending.Dequeue();
                    }
                }
                finally
                {
                    _writeGate.Release();
                }
                attempt = 0;
                SetState(ConnectionState.Connected, null);

                await foreach (var msg in call.ResponseStream.ReadAllAsync(_cts.Token).ConfigureAwait(false))
                {
                    Dispatch(new SemaEvent(msg.Event, msg.Data, msg.CmdId, msg.SessionId));
                }
                // 流被服务端正常终止：也按断线处理进入重连
            }
            catch (OperationCanceledException) when (_cts.IsCancellationRequested)
            {
                // 主动 Close
            }
            catch (Exception e)
            {
                err = e;
            }
            finally
            {
                await _writeGate.WaitAsync().ConfigureAwait(false);
                _streamReady = false;
                _requests = null;
                _writeGate.Release();
                try { call?.Dispose(); } catch { }
                try { channel?.Dispose(); } catch { }
            }

            if (_closed || _cts.IsCancellationRequested) break;
            attempt++;
            if (!_reconnectEnabled || (_maxAttempts > 0 && attempt > _maxAttempts))
            {
                _closed = true;
                SetState(ConnectionState.Closed, err ?? new InvalidOperationException("桥主动关闭了连接"));
                return;
            }
            SetState(ConnectionState.Reconnecting, err);
            var backoffMs = Math.Min(
                _initialBackoff.TotalMilliseconds * Math.Pow(2, Math.Min(attempt - 1, 20)),
                _maxBackoff.TotalMilliseconds);
            try
            {
                await Task.Delay(TimeSpan.FromMilliseconds(backoffMs), _cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    // ── 分发 ─────────────────────────────────────────────────────────────

    private void Dispatch(SemaEvent evt)
    {
        Action<SemaEvent>[] listeners;
        lock (_eventListeners) listeners = _eventListeners.ToArray();
        foreach (var l in listeners)
        {
            try { l(evt); } catch { /* 单个监听器异常不影响其他监听器 */ }
        }
    }

    private void SetState(ConnectionState state, Exception? error)
    {
        _state = state;
        Action<ConnectionState, Exception?>[] listeners;
        lock (_stateListeners) listeners = _stateListeners.ToArray();
        foreach (var l in listeners)
        {
            try { l(state, error); } catch { }
        }
    }
}

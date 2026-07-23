using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Semacore;
using Semacore.Protocol;
using Semacore.Transport;

namespace Semacore.Runtime;

/// <summary>
/// sema-grpc sidecar（Node 进程）生命周期管理（镜像 Java runtime/SidecarManager）。
///
/// <list type="bullet">
///   <item><b>一个 SidecarManager = 一个 sidecar 进程</b>（共享同一 SemaCore + 会话池）；
///     <see cref="NewConnection"/> 可开任意多条独立 gRPC 连接。</item>
///   <item><b>启动异步且幂等</b>：<see cref="Start"/> 拉起进程并等待 stdout 的
///     <c>SEMA_BRIDGE_PORT_ACTUAL=&lt;port&gt;</c> 端口握手（SEMA_BRIDGE_PORT=0 由系统分配空闲端口，
///     多实例不撞端口）。NewConnection 预接 portTask，进程就绪前的指令自动缓冲。</item>
///   <item><b>sidecar 目录解析</b>：构造参数显式指定 → SEMA_SIDECAR_DIR 环境变量 →
///     程序集内嵌 <c>sema-sidecar/server.js</c> 释放到 <c>~/.sema/csharp-sdk-sidecar</c>
///     （≙ Java jar 内嵌 / Python 包数据）。</item>
///   <item><b>Node 供应可插拔</b>：默认 <see cref="NodeProviders.System"/> 走「本地优先 →
///     ~/.sema/node 缓存 → 按需下载」（SEMA_NODE_PATH → 登录 shell PATH → 常见路径 →
///     缓存 → 下载）；需要其他策略的宿主注入 <see cref="NodeProvider"/>。</item>
///   <item>注入 <c>SEMA_BRIDGE_PARENT_OWNED=1</c>：生命周期归本 manager（Close 发 SIGTERM），
///     终端宿主的 Ctrl-C 广播 SIGINT 时桥忽略，保住「第一次 Ctrl-C 只中断会话」语义。</item>
/// </list>
/// </summary>
public sealed class SidecarManager : IAsyncDisposable
{
    private static readonly Regex PortPattern = new(@"SEMA_BRIDGE_PORT_ACTUAL=(\d+)");
    /// <summary>与 Java SidecarManager 兼容的三种产物布局：esbuild 单文件 / dist / 旧 tsc。</summary>
    private static readonly string[] ServerJsCandidates = { "server.js", "dist/server.js", "dist/src/server.js" };

    private readonly string? _sidecarDir;
    private readonly string _workingDir;
    private readonly NodeProvider _nodeProvider;
    private readonly Dictionary<string, string> _extraEnv;
    private readonly string _extractDir;
    private readonly Action<string>? _logConsumer;
    private readonly Action<int>? _onExit;

    private readonly TaskCompletionSource<int> _port = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object _lock = new();
    private Process? _process;
    private bool _started;
    private volatile bool _stopped;

    /// <param name="sidecarDir">含 server.js 的 sema-grpc 产物目录（也可用 SEMA_SIDECAR_DIR 环境变量指定）</param>
    /// <param name="workingDir">Agent 操作的目标工程路径（SEMA_WORKING_DIR），默认当前目录</param>
    /// <param name="env">附加/覆盖 sidecar 子进程环境变量</param>
    /// <param name="nodeProvider">Node 供应策略，默认 <see cref="NodeProviders.System"/></param>
    /// <param name="extractDir">程序集内嵌 sidecar 的释放目录，默认 ~/.sema/csharp-sdk-sidecar</param>
    /// <param name="logConsumer">sidecar stdout/stderr 行消费者（接宿主日志系统）</param>
    /// <param name="onExit">进程退出回调（参数为退出码）；宿主可据此决定重启策略</param>
    public SidecarManager(
        string? sidecarDir = null,
        string? workingDir = null,
        IDictionary<string, string>? env = null,
        NodeProvider? nodeProvider = null,
        string? extractDir = null,
        Action<string>? logConsumer = null,
        Action<int>? onExit = null)
    {
        _sidecarDir = sidecarDir;
        _workingDir = workingDir ?? Directory.GetCurrentDirectory();
        _nodeProvider = nodeProvider ?? NodeProviders.System();
        _extraEnv = new Dictionary<string, string>(env ?? new Dictionary<string, string>());
        _extractDir = extractDir ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".sema", "csharp-sdk-sidecar");
        _logConsumer = logConsumer;
        _onExit = onExit;
    }

    // ── 生命周期 ─────────────────────────────────────────────────────────

    /// <summary>拉起 sidecar（异步、幂等），返回端口 Task。boot（含 node 探测）在线程池执行，不阻塞调用线程。</summary>
    public Task<int> Start()
    {
        lock (_lock)
        {
            if (_stopped) throw new InvalidOperationException("SidecarManager 已停止");
            if (!_started)
            {
                _started = true;
                Task.Run(Boot);
            }
        }
        return _port.Task;
    }

    /// <summary>实际监听端口；未就绪时为 -1。</summary>
    public int Port => _port.Task is { Status: TaskStatus.RanToCompletion } t ? t.Result : -1;

    public bool IsRunning => _process is { HasExited: false };

    /// <summary>停止 sidecar 进程（SIGTERM，3s 宽限后强杀）。</summary>
    public async Task Close()
    {
        Process? process;
        lock (_lock)
        {
            _stopped = true;
            process = _process;
            _process = null;
        }
        if (process != null)
        {
            try
            {
                Terminate(process);
                using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
            }
            catch
            {
                try { process.Kill(entireProcessTree: true); } catch { }
            }
        }
        _port.TrySetException(new InvalidOperationException("sidecar 已停止"));
    }

    public ValueTask DisposeAsync() => new(Close());

    // ── 连接工厂 ─────────────────────────────────────────────────────────

    /// <summary>新开一条预接本 sidecar 端口、已启动的独立连接（隐式触发 <see cref="Start"/>；每个 UI 面板 / 逻辑单元一条）。</summary>
    public BridgeConnection NewConnection()
    {
        var conn = new BridgeConnection(portTask: Start());
        conn.Connect();
        return conn;
    }

    /// <summary>新开一条连接并包装为协议层客户端。</summary>
    public SemaBridgeClient NewClient() => new(NewConnection());

    /// <summary>
    /// 新开一条连接并初始化镜像 API 入口（≙ Node: <c>new SemaCore(config)</c>）。
    /// init 非破坏式：sidecar 内 core 已存在时只做就绪确认，config 不覆盖已有配置。
    /// </summary>
    public Task<SemaCore> NewCore(Types.SemaCoreConfig? config = null)
        => SemaCore.Attach(NewClient(), config);

    // ── 启动实现 ─────────────────────────────────────────────────────────

    private async Task Boot()
    {
        try
        {
            var serverJs = ResolveServerJs();
            var node = _nodeProvider();

            var psi = new ProcessStartInfo(node)
            {
                WorkingDirectory = Path.GetDirectoryName(serverJs)!,
                // stdin 管道只握不写：宿主死亡（含强杀）管道关闭，桥据此孤儿自检退出
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            psi.ArgumentList.Add(serverJs);
            var env = psi.Environment;
            // 0 = 系统分配空闲端口；宿主显式传 SEMA_BRIDGE_PORT 时尊重宿主
            if (!env.ContainsKey("SEMA_BRIDGE_PORT")) env["SEMA_BRIDGE_PORT"] = "0";
            env["SEMA_WORKING_DIR"] = _workingDir;
            // 生命周期由本 manager 管（Close 发 SIGTERM）：终端宿主的 Ctrl-C 会把 SIGINT 发给
            // 整个前台进程组，桥必须忽略 SIGINT，否则「第一次 Ctrl-C 只中断会话」的语义会被破坏
            env["SEMA_BRIDGE_PARENT_OWNED"] = "1";
            foreach (var (key, value) in _extraEnv) env[key] = value;

            // 组装子进程 PATH：node 所在目录 > 登录 shell/现有 PATH。
            // 只前置到 sidecar 子进程，不修改系统环境（sema-core 再 spawn node / npx / rg 时按 PATH 查找）
            var pathKey = env.Keys.FirstOrDefault(k => string.Equals(k, "PATH", StringComparison.OrdinalIgnoreCase)) ?? "PATH";
            var parts = new List<string> { Path.GetDirectoryName(Path.GetFullPath(node))! };
            var searchPath = NodeProviders.LoginShellPath();
            if (!string.IsNullOrWhiteSpace(searchPath)) parts.Add(searchPath);
            else if (env.TryGetValue(pathKey, out var existing) && !string.IsNullOrWhiteSpace(existing)) parts.Add(existing);
            env[pathKey] = string.Join(Path.PathSeparator, parts);

            var process = Process.Start(psi) ?? throw new IOException("无法启动 sidecar 进程");
            lock (_lock)
            {
                if (_stopped) // Close 与 boot 竞态：立即回收
                {
                    try { process.Kill(entireProcessTree: true); } catch { }
                    return;
                }
                _process = process;
            }

            // 读 stdout/stderr：日志转 logConsumer，捕获端口握手行
            var pumps = Task.WhenAll(Pump(process.StandardOutput), Pump(process.StandardError));
            await process.WaitForExitAsync().ConfigureAwait(false);
            await pumps.ConfigureAwait(false);
            _port.TrySetException(new InvalidOperationException(
                $"sidecar 进程退出前未上报端口（exit={process.ExitCode}；先确认 sdks/shared/bridge 已 npm run build）"));
            if (!_stopped) _onExit?.Invoke(process.ExitCode);
        }
        catch (Exception e)
        {
            _port.TrySetException(e);
        }
    }

    private async Task Pump(StreamReader reader)
    {
        string? line;
        while ((line = await reader.ReadLineAsync().ConfigureAwait(false)) != null)
        {
            _logConsumer?.Invoke(line);
            if (!_port.Task.IsCompleted)
            {
                var match = PortPattern.Match(line);
                if (match.Success) _port.TrySetResult(int.Parse(match.Groups[1].Value));
            }
        }
    }

    /// <summary>解析含 server.js 的 sidecar 目录并定位 server.js。</summary>
    private string ResolveServerJs()
    {
        var dir = _sidecarDir;
        if (dir == null)
        {
            var fromEnv = Environment.GetEnvironmentVariable("SEMA_SIDECAR_DIR");
            if (!string.IsNullOrWhiteSpace(fromEnv)) dir = fromEnv;
        }
        dir ??= ExtractBundledSidecar();
        if (dir == null)
        {
            throw new IOException("未找到 sidecar：请通过 sidecarDir 参数或环境变量 SEMA_SIDECAR_DIR "
                + "指向含 server.js 的 sema-grpc 目录");
        }
        foreach (var candidate in ServerJsCandidates)
        {
            var f = Path.Combine(dir, candidate);
            if (File.Exists(f)) return f;
        }
        throw new IOException($"sidecar 目录中未找到 server.js: {Path.GetFullPath(dir)}");
    }

    /// <summary>从程序集内嵌资源（sema-sidecar/server.js）释放 sidecar 到缓存目录；未内嵌时返回 null。</summary>
    private string? ExtractBundledSidecar()
    {
        var assembly = typeof(SidecarManager).Assembly;
        using (var server = assembly.GetManifestResourceStream("sema-sidecar/server.js"))
        {
            if (server == null) return null;
            Directory.CreateDirectory(_extractDir);
            using var file = File.Create(Path.Combine(_extractDir, "server.js"));
            server.CopyTo(file);
        }
        using (var proto = assembly.GetManifestResourceStream("sema-sidecar/proto/sema.proto"))
        {
            if (proto != null)
            {
                var protoDir = Path.Combine(_extractDir, "proto");
                Directory.CreateDirectory(protoDir);
                using var file = File.Create(Path.Combine(protoDir, "sema.proto"));
                proto.CopyTo(file);
            }
        }
        return _extractDir;
    }

    // ── 进程终止 ─────────────────────────────────────────────────────────

    [DllImport("libc", SetLastError = true, EntryPoint = "kill")]
    private static extern int SysKill(int pid, int sig);

    /// <summary>.NET 的 Process.Kill 在 Unix 上发 SIGKILL；桥需要 SIGTERM 才会走 dispose 清理（≙ Java destroy / Python terminate）。</summary>
    private static void Terminate(Process process)
    {
        if (OperatingSystem.IsWindows())
        {
            process.Kill(entireProcessTree: true);
            return;
        }
        try
        {
            SysKill(process.Id, 15); // 15 = SIGTERM
        }
        catch
        {
            process.Kill(entireProcessTree: true);
        }
    }
}

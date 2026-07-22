using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Semacore;
using Semacore.Events;
using Semacore.Types;

namespace Sema.Example.Demo;

/// <summary>
/// 入口 1：交互式 CLI —— <c>example/demo/src/cli.ts</c> 的 C# 镜像（方法名/参数/事件名与 Node 版一致）。
///
/// 用法：
///   dotnet run -- /path/to/project           指定项目目录（必填），新建会话
///   dotnet run -- /path/to/project 会话id     指定目录 + 加载历史会话
///
/// 模型自动读取 ~/.sema/model.conf（见 README），代码里无需配置模型。
///
/// 中断语义与 Node 版一致：esc / Ctrl-C 第一次中断当前轮（session.Interrupt()），第二次退出；
/// 恢复运行（state 回到 processing）后计数清零。esc 检测靠 Console.ReadKey 逐键读
/// （.NET 原生解析按键，≙ Node 的 setRawMode，无需 stty；非 TTY 如管道输入时自动整行读，
/// ≙ cli.ts 的 isTTY 判断）。
///
/// 线程模型：SDK 事件回调跑在 gRPC 读循环上，只允许打印或向队列写入，绝不能在回调里
/// 读 stdin 或同步阻塞等待 SDK 的 Task（.Wait()/.Result 会死锁——ack 与后续事件在同一读循环
/// 串行分发）。专设 stdin-reader 线程逐键读键盘（esc 即时生效），组装好的整行进 lineQueue，
/// 由主循环按 uiQueue 的节奏消费。
/// </summary>
public static class Cli
{
    private const int MaxLogLen = 200;

    /// <summary>需要主循环处理的 UI 事件（事件回调只入队，主循环独占消费）。</summary>
    private abstract record UiEvent
    {
        public sealed record AskInput : UiEvent;
        public sealed record Permission(string? ToolId, string? ToolName) : UiEvent;
        public sealed record Error(string Message) : UiEvent;
        public sealed record Quit : UiEvent;
    }

    private static readonly Channel<UiEvent> UiQueue = Channel.CreateUnbounded<UiEvent>();
    /// <summary>stdin-reader 线程组装好的整行；null 表示 EOF。</summary>
    private static readonly Channel<string?> LineQueue = Channel.CreateUnbounded<string?>();
    private static int _askPending;      // ≙ cli.ts 的 awaitingInput（0/1，CAS 防重复弹出输入）
    private static int _subAgentDepth;
    /// <summary>≙ cli.ts 的 interruptCount：第一次中断会话，第二次退出。</summary>
    private static int _interruptCount;
    private static SemaSession? _session;

    public static async Task<int> Execute(string[] args)
    {
        var positional = args.Where(a => !a.StartsWith('-')).ToList();
        var workingDir = positional.Count > 0 ? positional[0] : null;
        var resumeSessionId = positional.Count > 1 ? positional[1] : null;
        if (workingDir == null)
        {
            Console.Error.WriteLine("用法: dotnet run -- <项目目录> [会话id]");
            return 1;
        }
        if (!Directory.Exists(workingDir))
        {
            Console.Error.WriteLine($"项目目录不存在或不是目录: {workingDir}");
            return 1;
        }

        // ≙ Node: new SemaCore({...})，配置项一字不差。sidecar 内嵌在 SDK 程序集里，
        // 由 Start() 自动释放并拉起，Close() 级联清理。
        var core = await SemaCore.Start(new SemaCoreConfig
        {
            WorkingDir = workingDir,
            LogLevel = "none",
            Thinking = true,
            DisableTopicDetection = true,
            DisableBackgroundTasks = true,
            DisabledTools = new List<string> { "ask_form", "plan_to_agent" },
        });

        try
        {
            var session = await core.CreateSession(resumeSessionId != null
                ? new CreateSessionOptions { SessionId = resumeSessionId }
                : null);
            _session = session;
            Console.WriteLine(Green($"会话id: {session.SessionId}")
                + Gray(resumeSessionId != null ? " (已加载历史会话)" : " (新建会话)"));

            // ≙ cli.ts 的 process.on('SIGINT') + setRawMode + keypress(escape)
            Console.CancelKeyPress += OnCancelKeyPress;
            StartStdinReader();

            Subscribe(session);
            await ConversationLoop(session);

            Console.WriteLine("\n=== 会话结束 ===");
            try
            {
                await core.CloseSession(session.SessionId).WaitAsync(TimeSpan.FromSeconds(5));
            }
            catch
            {
                // 退出路径尽力而为
            }
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("错误: " + RootMessage(e)
                + Gray("（排查：sdks/shared/bridge 是否已 npm run build；未找到 node 时装 node ≥18 或设 SEMA_NODE_PATH）"));
            return 1;
        }
        finally
        {
            await core.Close();
        }
    }

    // ── 中断处理（≙ cli.ts 的 SIGINT / esc 两个入口） ─────────────────────

    private static void OnCancelKeyPress(object? sender, ConsoleCancelEventArgs e)
    {
        e.Cancel = true; // 拦截 Ctrl-C，不让进程直接退出
        Console.WriteLine("\n⚠️  中断会话...");
        InterruptOrExit();
    }

    /// <summary>第一次中断会话，第二次退出（计数在回到 processing 或发送新消息时清零）。</summary>
    private static void InterruptOrExit()
    {
        var session = _session;
        if (session != null && Interlocked.Increment(ref _interruptCount) == 1)
        {
            _ = session.Interrupt(); // fire-and-forget，可从任意线程调用
        }
        else
        {
            // 第二次：解锁主循环（无论卡在 uiQueue 还是 lineQueue），由 Execute 的 finally 级联清理 sidecar
            LineQueue.Writer.TryWrite(null);
            UiQueue.Writer.TryWrite(new UiEvent.Quit());
        }
    }

    // ── stdin 读取线程 ────────────────────────────────────────────────────

    private static void StartStdinReader()
    {
        var thread = new Thread(Console.IsInputRedirected ? LineReadLoop : RawReadLoop)
        {
            IsBackground = true,
            Name = "stdin-reader",
        };
        thread.Start();
    }

    /// <summary>TTY：逐键读（esc 即时触发中断），自行回显与组行（≙ Node readline 在 raw 模式下的职责）。</summary>
    private static void RawReadLoop()
    {
        var buf = new StringBuilder();
        try
        {
            while (true)
            {
                // .NET 已把方向键等 CSI 序列解析成 ConsoleKey，无需像 Java/Python 版手工丢弃
                var key = Console.ReadKey(intercept: true);
                if (key.Key == ConsoleKey.Escape)
                {
                    InterruptOrExit();
                }
                else if (key.Key == ConsoleKey.Enter)
                {
                    Console.WriteLine();
                    LineQueue.Writer.TryWrite(buf.ToString());
                    buf.Clear();
                }
                else if (key.Key == ConsoleKey.Backspace)
                {
                    if (buf.Length > 0)
                    {
                        var last = buf[^1];
                        buf.Length--;
                        Console.Write(last > 0xFF ? "\b\b  \b\b" : "\b \b"); // CJK 等宽字符占两格
                    }
                }
                else if (key.KeyChar >= ' ' || char.IsSurrogate(key.KeyChar))
                {
                    buf.Append(key.KeyChar); // emoji 等增补字符按代理项成对到达，逐个追加即可
                    Console.Write(key.KeyChar);
                }
                // KeyChar == 0 的功能键（方向键等）直接忽略
            }
        }
        catch
        {
            // stdin 关闭 / 终端不可用
        }
        LineQueue.Writer.TryWrite(null);
    }

    /// <summary>非 TTY（管道/重定向）：整行读，无 raw 模式（≙ cli.ts 非 isTTY 分支）。</summary>
    private static void LineReadLoop()
    {
        try
        {
            string? line;
            while ((line = Console.In.ReadLine()) != null) LineQueue.Writer.TryWrite(line);
        }
        catch
        {
        }
        LineQueue.Writer.TryWrite(null);
    }

    /// <summary>取一行用户输入；EOF 返回 null。</summary>
    private static async Task<string?> NextLine() => await LineQueue.Reader.ReadAsync();

    // ── 事件订阅与对话循环 ────────────────────────────────────────────────

    /// <summary>事件订阅（对应 cli.ts 各节）。铁律：所有回调在 gRPC 读循环执行，只许 print/入队。</summary>
    private static void Subscribe(SemaSession session)
    {
        // 工具/任务事件：仅打印标题（截断超长内容）
        var logEvents = new[]
        {
            "tool:execution:complete",
            "tool:execution:error",
            "tool:permission:request",
            "task:agent:start",
            "task:agent:end",
            "todos:update",
            "session:interrupted",
        };
        foreach (var e in logEvents)
        {
            var name = e;
            session.On(name, data => Console.WriteLine(Gray($"{name}|{Truncate(Stringify(data))}")));
        }

        // 子代理深度跟踪：message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断是否在子代理内
        session.On("task:agent:start", _ => Interlocked.Increment(ref _subAgentDepth));
        session.On("task:agent:end", _ =>
        {
            if (Interlocked.Decrement(ref _subAgentDepth) < 0) Interlocked.Exchange(ref _subAgentDepth, 0);
        });

        // 流式输出：仅主代理，避免子代理文本混入主输出
        session.On("message:text:chunk", data =>
        {
            var delta = SemaJson.Str(data, "delta");
            if (_subAgentDepth > 0 || string.IsNullOrEmpty(delta)) return;
            Console.Write(delta);
        });
        session.On("message:complete", data =>
        {
            var agentId = SemaJson.Str(data, "agentId");
            if (agentId == null || agentId == Constants.MAIN_AGENT_ID) Console.WriteLine();
        });

        // 权限交互：入队交主循环读 y/n（不能在本回调里读 stdin）
        session.On("tool:permission:request", data => UiQueue.Writer.TryWrite(
            new UiEvent.Permission(SemaJson.Str(data, "toolId"), SemaJson.Str(data, "toolName"))));

        // 恢复运行后重置中断计数（≙ cli.ts 的 state==='processing' 分支）
        session.On("state:update", data =>
        {
            var state = SemaJson.Str(data, "state");
            if (state == "processing") Interlocked.Exchange(ref _interruptCount, 0);
            if (state == "idle") EnqueueAsk(); // 以主代理回到 idle 作为一轮结束信号
        });
        session.On("session:interrupted", _ => EnqueueAsk());
        // 会话初始即 idle 不会触发 state:update，故靠 session:ready 弹首条输入（SDK 缓存重放，不惧订阅晚于事件）
        session.Once("session:ready", _ => EnqueueAsk());
        session.Once("session:error", data =>
        {
            var message = SemaJson.Str(data, "message");
            UiQueue.Writer.TryWrite(new UiEvent.Error(message ?? Stringify(data)));
        });
    }

    /// <summary>对话循环：主循环逐个消费 UI 事件，用户输入行来自 stdin-reader 线程。</summary>
    private static async Task ConversationLoop(SemaSession session)
    {
        while (true)
        {
            var ev = await UiQueue.Reader.ReadAsync();
            switch (ev)
            {
                case UiEvent.Quit:
                    return;
                case UiEvent.Error error:
                    throw new InvalidOperationException(error.Message);
                case UiEvent.Permission permission:
                {
                    Console.Write(Blue("👤 权限响应 (y=agree / n=refuse): "));
                    var answer = await NextLine();
                    if (answer == null) return; // EOF 视同退出
                    var selected = answer.Trim().Equals("n", StringComparison.OrdinalIgnoreCase) ? "refuse" : "agree";
                    // fire-and-forget：绝不同步等待（ack 由同一条读循环分发）
                    _ = session.RespondToToolPermission(new ToolPermissionResponse
                    {
                        ToolId = permission.ToolId,
                        ToolName = permission.ToolName,
                        Selected = selected,
                    });
                    break;
                }
                case UiEvent.AskInput:
                {
                    Console.Write(Blue("\n👤 消息 (esc中断): "));
                    var line = await NextLine();
                    Interlocked.Exchange(ref _askPending, 0); // 读到输入后才复位，镜像 cli.ts 的 awaitingInput 时序
                    if (line == null) return; // EOF（管道输入耗尽）视同退出
                    var input = line.Trim();
                    if (input is "exit" or "quit") return;
                    if (input.Length == 0)
                    {
                        EnqueueAsk(); // 空输入：重新询问
                        break;
                    }
                    Console.Write("\n" + Green("🤖 AI: "));
                    Interlocked.Exchange(ref _interruptCount, 0); // ≙ cli.ts askAndSend 发送前清零
                    _ = session.ProcessUserInput(input); // fire-and-forget，回复走事件流
                    break;
                }
            }
        }
    }

    /// <summary>ready/idle/interrupted 都可能触发询问，CAS 防重复弹出输入。</summary>
    private static void EnqueueAsk()
    {
        if (Interlocked.CompareExchange(ref _askPending, 1, 0) == 0)
            UiQueue.Writer.TryWrite(new UiEvent.AskInput());
    }

    // ── 工具函数 ─────────────────────────────────────────────────────────

    private static string Stringify(JsonElement? data) => data?.GetRawText() ?? "null";

    private static string Truncate(string s)
        => s.Length > MaxLogLen ? $"{s[..MaxLogLen]}...({s.Length - MaxLogLen} more)" : s;

    private static string RootMessage(Exception e)
    {
        var root = e;
        while (root.InnerException != null) root = root.InnerException;
        return root.Message;
    }

    private static string Gray(string s) => $"\u001b[90m{s}\u001b[0m";
    private static string Blue(string s) => $"\u001b[34m{s}\u001b[0m";
    private static string Green(string s) => $"\u001b[32m{s}\u001b[0m";
}

using System.Text.Json;
using System.Text.RegularExpressions;
using Semacore;
using Semacore.Types;

namespace Sema.Example.Demo;

/// <summary>
/// 入口 2：一次性执行（非交互）—— <c>example/demo/src/run.ts</c> 的 C# 镜像。
///
/// 用法：
///   dotnet run -- exec &lt;项目路径&gt; "&lt;用户输入&gt;" [verbose|medium|simple|minimal]
///
/// 详略档位（所有工具都只打印「标题」）：
///   verbose  详细：AI 文本 + 全部工具标题 + 错误 + 子代理 + todos
///   medium   中等：AI 文本 + 仅文件编辑/终端工具标题
///   simple   简单：仅同步 AI 文本内容
///   minimal  极简：仅同步最终结论
///
/// 模型自动读取 ~/.sema/model.conf（见 README），代码里无需配置模型。
/// </summary>
public static class Run
{
    // 文件编辑 / 终端类工具名（medium 档位只展示这些工具的标题）
    private static readonly HashSet<string> EditTerminalTools = new() { "write_file", "patch_file", "edit_notebook", "run_shell" };
    // 文件编辑类（不含 run_shell）：标题后附带 +增 -删 行数
    private static readonly HashSet<string> FileEditTools = new() { "write_file", "patch_file", "edit_notebook" };

    // ── 展示状态：所有事件回调在同一条 gRPC 读循环上串行执行，无需加锁 ──
    private static string _verbosity = "verbose";
    private static string _finalText = "";
    private static bool _pendingNewline; // stdout 是否停在半行（流式写入后未换行）
    private static int _subAgentDepth;   // message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断
    private static readonly List<string> PendingReads = new(); // 攒批的只读探查桶名

    public static async Task<int> Execute(string[] args)
    {
        // 取位置参数（过滤掉 - 开头的 flag，与 cli 一致）
        var positional = args.Where(a => !a.StartsWith('-')).ToList();
        var projectPath = positional.Count > 0 ? positional[0] : null;
        var userInput = positional.Count > 1 ? positional[1] : null;
        var rawVerbosity = positional.Count > 2 ? positional[2] : "verbose";
        if (projectPath == null || userInput == null)
        {
            Console.Error.WriteLine("用法: dotnet run -- exec <项目路径> \"<用户输入>\" [verbose|medium|simple|minimal]");
            return 1;
        }
        if (!Directory.Exists(projectPath))
        {
            Console.Error.WriteLine($"项目路径不存在或不是目录: {projectPath}");
            return 1;
        }
        var allowed = new[] { "verbose", "medium", "simple", "minimal" };
        if (!allowed.Contains(rawVerbosity))
        {
            Console.Error.WriteLine($"未知档位 \"{rawVerbosity}\"，可选：{string.Join(" | ", allowed)}");
            return 1;
        }
        _verbosity = rawVerbosity;

        // ≙ Node: new SemaCore({...})，配置项一字不差。
        // 非交互：直接跳过所有权限检查，避免一次性执行卡在权限询问
        // （不同于 AutoRun——AutoRun 仍会用快速模型判断，命中风险会转人工，无人应答时会挂起）
        var core = await SemaCore.Start(new SemaCoreConfig
        {
            WorkingDir = projectPath,
            LogLevel = "none",
            Thinking = true,
            DisableTopicDetection = true,
            DisableBackgroundTasks = true,
            DisabledTools = new List<string> { "ask_form", "plan_to_agent" },
            SkipShellExecPermission = true,
            SkipFileEditPermission = true,
            SkipSkillPermission = true,
            SkipMCPToolPermission = true,
            SkipFetchUrlPermission = true,
            SkipExternalFileReadPermission = true,
        });

        try
        {
            var session = await core.CreateSession();
            Subscribe(session);

            // 完成信号：主代理回到 idle（整轮含工具调用结束后只发一次 idle）
            var done = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
            session.Once("session:error", d =>
            {
                FlushReadBatch();
                var message = SemaJson.Str(SemaJson.Get(d, "error"), "message");
                done.TrySetException(new InvalidOperationException(
                    message ?? SemaJson.Str(d, "type", d?.GetRawText() ?? "session:error")));
            });
            session.On("state:update", d =>
            {
                if (SemaJson.Str(d, "state") == "idle") done.TrySetResult(null);
            });
            session.Once("session:ready", d => { _ = session.ProcessUserInput(userInput); });
            await done.Task;

            if (_verbosity == "minimal")
            {
                Console.WriteLine(Green(_finalText.Length == 0 ? "(无结论)" : _finalText));
            }
            await session.Close();
            return 0;
        }
        catch (Exception e)
        {
            var root = e;
            while (root.InnerException != null) root = root.InnerException;
            Console.Error.WriteLine($"错误: {root.Message}");
            return 1;
        }
        finally
        {
            await core.Close();
        }
    }

    /// <summary>事件订阅（对应 run.ts 各节）。回调只做打印/状态更新，禁同步阻塞等待。</summary>
    private static void Subscribe(SemaSession session)
    {
        var isMinimal = _verbosity == "minimal";
        var isVerbose = _verbosity == "verbose";

        session.On("task:agent:start", d =>
        {
            _subAgentDepth++;
            if (isVerbose)
            {
                FlushNewline();
                Console.WriteLine(Gray($"🤖 子代理开始: {SemaJson.Str(d, "title", "")}"));
            }
        });
        session.On("task:agent:end", d =>
        {
            if (_subAgentDepth > 0) _subAgentDepth--;
            if (isVerbose) Console.WriteLine(Gray($"✅ 子代理结束: {SemaJson.Str(d, "title", "")}"));
        });

        // 文本流式（仅主代理）；minimal 不流式，只在 message:complete 记录结论
        if (!isMinimal)
        {
            session.On("message:text:chunk", d =>
            {
                var delta = SemaJson.Str(d, "delta");
                if (_subAgentDepth > 0 || string.IsNullOrEmpty(delta)) return;
                FlushReadBatch(); // 主代理开始说话前，先把攒着的只读探查汇总打出来
                Console.Write(delta);
                _pendingNewline = true;
            });
        }

        session.On("message:complete", d =>
        {
            if (!IsMain(SemaJson.Str(d, "agentId"))) return;
            if (!isMinimal) FlushNewline();
            // 只在本轮不再调工具（turn 结束）时冲刷；中间的纯工具轮不切断连续的只读探查
            if (!SemaJson.Bool(d, "hasToolCalls", false))
            {
                FlushReadBatch();
                var content = SemaJson.Str(d, "content");
                if (!string.IsNullOrEmpty(content)) _finalText = content;
            }
        });

        if (isVerbose || _verbosity == "medium")
        {
            session.On("tool:execution:complete", d =>
            {
                if (!IsMain(SemaJson.Str(d, "agentId"))) return;
                var toolName = SemaJson.Str(d, "toolName", "")!;
                var title = SemaJson.Str(d, "title", "")!.Trim();
                // 只读探查类：verbose 攒着合并汇总；medium 不显示只读信息
                var bucket = ReadToolBucket(toolName, title);
                if (bucket != null)
                {
                    if (isVerbose) PendingReads.Add(bucket);
                    return;
                }
                // medium 只展示文件编辑与终端工具，其余（skill / mcp / fetch 等）不外发
                if (_verbosity == "medium" && !EditTerminalTools.Contains(toolName)) return;
                FlushReadBatch();
                FlushNewline();
                var label = title.Length == 0 ? toolName : title;
                var stat = FileEditTools.Contains(toolName) ? FormatDiffStat(SemaJson.Get(d, "content")) : "";
                Console.WriteLine(Gray($"{ToolIcon(toolName)} {label}{(stat.Length == 0 ? "" : " " + stat)}"));
            });
        }
        if (isVerbose)
        {
            session.On("tool:execution:error", d =>
            {
                if (!IsMain(SemaJson.Str(d, "agentId"))) return;
                FlushReadBatch();
                FlushNewline();
                var label = SemaJson.Str(d, "title", "")!.Trim();
                if (label.Length == 0) label = SemaJson.Str(d, "toolName", "工具执行失败")!;
                Console.WriteLine(Gray($"❌ {label}"));
            });
            session.On("todos:update", d =>
            {
                FlushReadBatch();
                FlushNewline();
                var n = d is { ValueKind: JsonValueKind.Array } arr ? arr.GetArrayLength() : 0;
                Console.WriteLine(Gray($"📋 todos: {n} 项"));
            });
        }
    }

    private static bool IsMain(string? agentId)
        => agentId == null || agentId == Constants.MAIN_AGENT_ID;

    private static void FlushNewline()
    {
        if (_pendingNewline)
        {
            Console.WriteLine();
            _pendingNewline = false;
        }
    }

    /// <summary>连续的只读探查工具合并成一条 🔍 汇总，避免逐条刷屏。</summary>
    private static void FlushReadBatch()
    {
        if (PendingReads.Count == 0) return;
        var parts = new List<string>();
        var files = PendingReads.Count(b => b == "文件");
        var searches = PendingReads.Count(b => b == "搜索");
        var dirs = PendingReads.Count(b => b == "目录");
        var probes = PendingReads.Count(b => b == "探查");
        if (files > 0) parts.Add($"读取 {files} 个文件");
        if (searches > 0) parts.Add($"搜索 {searches} 次");
        if (dirs > 0) parts.Add($"列出 {dirs} 个目录");
        if (probes > 0) parts.Add($"探查 {probes} 次");
        PendingReads.Clear();
        FlushNewline();
        Console.WriteLine(Gray($"🔍 {string.Join("、", parts)}"));
    }

    // ── 工具展示辅助（与 run.ts 逐函数对应） ─────────────────────────────

    /// <summary>按工具类型给区分化图标，比单一 🔧 更易辨认。</summary>
    private static string ToolIcon(string toolName)
    {
        if (FileEditTools.Contains(toolName)) return "📝";
        if (toolName == "run_shell") return "💻";
        if (toolName == "skill") return "🧩";
        if (toolName.StartsWith("mcp__", StringComparison.Ordinal)) return "🔌";
        if (toolName == "fetch_url") return "🌐";
        return "🔧";
    }

    /// <summary>从工具 content（结构 {type, patch}）统计 +增 -删，如 "+12 -2" / "+12" / ""。</summary>
    private static string FormatDiffStat(JsonElement? content)
    {
        if (SemaJson.Get(content, "patch") is not { ValueKind: JsonValueKind.Array } patch) return "";
        var added = 0;
        var removed = 0;
        if (SemaJson.Str(content, "type") == "new")
        {
            foreach (var h in patch.EnumerateArray()) added += SemaJson.I32(h, "newLines", 0);
        }
        else
        {
            foreach (var h in patch.EnumerateArray())
            {
                if (SemaJson.Get(h, "lines") is not { ValueKind: JsonValueKind.Array } lines) continue;
                foreach (var line in lines.EnumerateArray())
                {
                    var s = line.ValueKind == JsonValueKind.String ? line.GetString() ?? "" : "";
                    if (s.StartsWith('+')) added++;
                    else if (s.StartsWith('-')) removed++;
                }
            }
        }
        var parts = new List<string>();
        if (added > 0) parts.Add($"+{added}");
        if (removed > 0) parts.Add($"-{removed}");
        return string.Join(" ", parts);
    }

    /// <summary>只读探查类工具归桶：查看文件 / 搜索 / ls 列目录 / find·pwd·探查链；其余返回 null 照常单条展示。</summary>
    private static string? ReadToolBucket(string toolName, string title)
    {
        if (toolName == "view_file") return "文件";
        if (toolName is "search_files" or "search_content") return "搜索";
        if (toolName == "run_shell")
        {
            if (IsLsCommand(title)) return "目录";
            if (IsFindCommand(title) || IsPwdCommand(title) || IsExploratoryCommand(title)) return "探查";
        }
        return null;
    }

    private static readonly Regex CdSeg = new(@"^cd(?:\s|$).*");
    private static readonly Regex LsSeg = new(@"^ls(?:\s.*)?$");
    private static readonly Regex FindSeg = new(@"^find(?:\s.*)?$");
    private static readonly Regex FindSideEffect = new(@"(?:^|\s)-(?:delete|exec|execdir|ok|okdir)(?:\s|$)");
    private static readonly Regex PwdSeg = new(@"^pwd(?:\s+-(?:L|P))*\s*$");

    /// <summary>title 形如 `cd a &amp;&amp; ls foo`：跳过开头的 cd 段后剩余命令以 ls 开头即视为列目录。</summary>
    private static bool IsLsCommand(string title)
    {
        var segs = SplitAnd(title);
        var i = 0;
        while (i < segs.Count - 1 && CdSeg.IsMatch(segs[i])) i++;
        return i < segs.Count && LsSeg.IsMatch(segs[i]);
    }

    /// <summary>find 查找（排除 -delete/-exec 等有副作用的破坏性用法）。</summary>
    private static bool IsFindCommand(string title)
    {
        var c = title.Trim();
        if (!FindSeg.IsMatch(c)) return false;
        return !FindSideEffect.IsMatch(c);
    }

    private static bool IsPwdCommand(string title) => PwdSeg.IsMatch(title.Trim());

    /// <summary>由 &amp;&amp; 串起且每段都是 ls / find / pwd 的纯探查链。</summary>
    private static bool IsExploratoryCommand(string title)
    {
        var segs = SplitAnd(title);
        if (segs.Count < 2) return false;
        return segs.All(s => IsLsCommand(s) || IsFindCommand(s) || IsPwdCommand(s));
    }

    private static List<string> SplitAnd(string title)
        => Regex.Split(title.Trim(), @"\s+&&\s+").Select(s => s.Trim()).Where(s => s.Length > 0).ToList();

    private static string Gray(string s) => $"\u001b[90m{s}\u001b[0m";
    private static string Green(string s) => $"\u001b[32m{s}\u001b[0m";
}

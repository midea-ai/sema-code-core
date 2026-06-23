using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SemaDemo;

// ── 配置 ─────────────────────────────────────────────────────────
const string BRIDGE_URL = "ws://localhost:3765";

Console.WriteLine("=== Sema C# Demo ===");
Console.WriteLine($"Connecting to sema-bridge at {BRIDGE_URL}...\n");

await using var client = new SemaCoreClient();

string Gray(string s) => $"\x1b[90m{s}\x1b[0m";
string Blue(string s) => $"\x1b[34m{s}\x1b[0m";
string Green(string s) => $"\x1b[32m{s}\x1b[0m";

// ── 日志事件（灰色输出，对应 quickstart.mjs events 数组）────────
foreach (var e in new[]
{
    "tool:execution:start", "tool:execution:complete", "tool:execution:error", "tool:permission:request",
    "task:agent:start", "task:agent:end", "todos:update", "session:interrupted"
})
{
    var eName = e;
    client.On(eName, data =>
        Console.WriteLine(Gray($"{eName}|{data?.ToString(Formatting.None) ?? ""}")));
}

// ── 主代理判断 + 子代理深度跟踪 ──────────────────────────────────
// message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断是否在子代理内
bool IsMain(string? agentId) => agentId == "main" || string.IsNullOrEmpty(agentId);
var subAgentDepth = 0;
client.On("task:agent:start", _ => subAgentDepth++);
client.On("task:agent:end", _ => { if (subAgentDepth > 0) subAgentDepth--; });

// ── 流式输出：仅主代理，避免子代理文本混入主输出 ─────────────────
client.On("message:text:chunk", data =>
{
    if (subAgentDepth > 0) return;
    Console.Write(data?["delta"]?.ToString() ?? "");
});

// ── 权限交互（覆盖日志处理器，追加用户确认逻辑）─────────────────
client.On("tool:permission:request", data =>
{
    var toolId = data?["toolId"]?.ToString() ?? "";
    var toolName = data?["toolName"]?.ToString() ?? "";
    Console.Write(Blue("👤 权限响应 (y=agree / a=allow / n=refuse): "));
    var answer = Console.ReadLine()?.Trim() ?? "y";
    var selected = answer switch { "a" => "allow", "n" => "refuse", _ => "agree" };
    _ = client.RespondToPermissionAsync(toolId, toolName, selected);
});

// ── 问答请求 ──────────────────────────────────────────────────────
client.On("ask:question:request", data =>
{
    var agentId = data?["agentId"]?.ToString() ?? "";
    var questions = data?["questions"];
    Console.WriteLine($"[Question] {questions}");
    Console.Write("Your answer: ");
    var input = Console.ReadLine() ?? "确认";
    var firstQuestion = questions?[0]?["question"]?.ToString() ?? "";
    _ = client.RespondToQuestionAsync(agentId, new Dictionary<string, string> { { firstQuestion, input } });
});

// ── Plan 退出请求 ─────────────────────────────────────────────────
client.On("plan:exit:request", data =>
{
    Console.WriteLine("[Plan] Exit plan mode — approving");
    var agentId = data?["agentId"]?.ToString() ?? "";
    _ = client.RespondToPlanExitAsync(agentId, "startEditing");
});

// ── 连接 ──────────────────────────────────────────────────────────
try
{
    await client.ConnectAsync(BRIDGE_URL);
    Console.WriteLine("Connected!\n");
}
catch (Exception ex)
{
    Console.Error.WriteLine($"Failed to connect: {ex.Message}");
    Console.Error.WriteLine("Make sure sema-bridge is running: cd sema-bridge && npm start");
    return;
}

// ── 核心配置（对应 quickstart.mjs 的 new SemaCore({...}) 选项）──────
await client.InitCoreAsync(new SemaCoreConfig
{
    WorkingDir = "/path/to/your/project", // Agent 将操作的目标代码仓库路径
    LogLevel = "none",
    Thinking = false,
    DisableBackgroundTasks = true,
    DisableTopicDetection = true,
    DisabledTools = ["ask_form", "plan_to_agent"] // 交互场景禁用无法应答的工具
});

// ── 配置模型（以 deepseek 为例，更多LLM服务商请见"新增模型"文档）──────
// 只需要加一次，后面可以注释掉添加模型相关代码
var modelConfig = new
{
    modelName = "deepseek-v4-flash",
    provider = "deepseek",
    baseURL = "https://api.deepseek.com/anthropic",
    apiKey = "sk-your-api-key",
    maxTokens = 32000,
    contextLength = 256000,
    adapt = "anthropic"
};
await client.AddModelAsync(modelConfig);
var modelId = $"{modelConfig.modelName}[{modelConfig.provider}]";
await client.ApplyTaskModelAsync(modelId, modelId);
Console.WriteLine($"Model configured: {modelId}\n");

// ── 创建会话，等待 session:ready ──────────────────────────────────
var sessionReadyTcs = new TaskCompletionSource<string>();
client.Once("session:ready", data =>
    sessionReadyTcs.TrySetResult(data?["sessionId"]?.ToString() ?? ""));

await client.CreateSessionAsync();
var sessionId = await sessionReadyTcs.Task;
Console.WriteLine($"Session ready: {sessionId}\n");

// ── Ctrl+C 中断 ───────────────────────────────────────────────────
var interrupted = false;
Console.CancelKeyPress += (_, e) =>
{
    if (!interrupted)
    {
        interrupted = true;
        e.Cancel = true;
        Console.WriteLine("\n⚠️  中断会话...");
        _ = client.InterruptAsync();
    }
    // 第二次 Ctrl+C 不取消，程序正常退出
};

// ── 对话循环：以主代理回到 idle 作为一轮结束信号 ──────────────────
var conversationTcs = new TaskCompletionSource();
var awaitingInput = false; // 防止多个结束信号（state:update / interrupted）重复弹出输入

// 对应 quickstart.mjs: core.once('session:error', reject)
client.Once("session:error", data =>
    conversationTcs.TrySetException(new Exception(data?["message"]?.ToString() ?? "")));

// 弹出下一条输入并发送（自带防重入）
async Task AskAndSendAsync()
{
    if (awaitingInput || conversationTcs.Task.IsCompleted) return;
    awaitingInput = true;
    try
    {
        while (true)
        {
            Console.Write(Blue("\n👤 消息 (esc中断): "));
            var input = Console.ReadLine()?.Trim() ?? "";
            if (input == "exit" || input == "quit") { conversationTcs.TrySetResult(); return; }
            if (string.IsNullOrEmpty(input)) continue; // 空输入：重新询问
            Console.Write(Green("\n🤖 AI: "));
            await client.SendUserInputAsync(input);
            return;
        }
    }
    catch (Exception ex)
    {
        conversationTcs.TrySetException(ex);
    }
    finally
    {
        awaitingInput = false;
    }
}

// 主代理消息完成 → 换行（整轮结束由 state:update=idle 统一触发）
client.On("message:complete", data =>
{
    if (IsMain(data?["agentId"]?.ToString())) Console.WriteLine();
});

// 整轮对话结束（工具循环全部跑完后只发一次 idle）→ 弹下一条输入
client.On("state:update", data =>
{
    if (data?["state"]?.ToString() == "idle") _ = AskAndSendAsync();
});

// 被中断后重新弹输入
client.On("session:interrupted", _ => AskAndSendAsync());

// 发首条输入（对应 quickstart.mjs 的 session:ready 后 askAndSend）
_ = AskAndSendAsync();

try
{
    await conversationTcs.Task;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"[Error] {ex.Message}");
}

Console.WriteLine("\n=== 会话结束 ===");

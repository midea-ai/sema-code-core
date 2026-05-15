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

// ── 流式输出 ──────────────────────────────────────────────────────
client.On("message:text:chunk", data =>
    Console.Write(data?["delta"]?.ToString() ?? ""));

client.On("message:complete", _ => Console.WriteLine());

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
    WorkingDir = "D:/Users/wujr59/sema-demo", // Agent 将操作的目标代码仓库路径
    LogLevel = "none",
    Thinking = false,
    DisableBackgroundTasks = true,
    DisableTopicDetection = true,
    // 按需启用其他选项：
    // SkipFileEditPermission = true,
    // SkipBashExecPermission = true,
    // AgentMode = "Plan",
    // SystemPrompt = "你是一个 C# 专家",
});

// ── 配置模型（以 qwen3.5-plus 为例，更多LLM服务商请见"新增模型"文档）──────
// 只需要加一次，后面可以注释掉添加模型相关代码
var modelConfig = new
{
    provider = "custom",
    modelName = "qwen3.5-plus",
    baseURL = "https://aimpapi.midea.com/t-aigc/llm-openai-api",
    apiKey = "sk-",
    maxTokens = 32000,
    contextLength = 256000,
    adapt = "openai"
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

// ── 对话循环（对应 quickstart.mjs 的 Promise + state:update 模式）─
var conversationTcs = new TaskCompletionSource();
var idleSignal = new SemaphoreSlim(0, 1);

// 对应 quickstart.mjs: core.once('session:error', reject)
client.Once("session:error", data =>
    conversationTcs.TrySetException(new Exception(data?["message"]?.ToString() ?? "")));

// 当 state:update 变为 idle 时释放信号
client.On("state:update", data =>
{
    if (data?["state"]?.ToString() == "idle" && idleSignal.CurrentCount == 0)
        idleSignal.Release();
});

async Task SendInputAsync(string input)
{
    Console.Write(Green("\n🤖 AI: "));
    await client.SendUserInputAsync(input);
    await idleSignal.WaitAsync();
    await Task.Delay(100);
}

// 初始消息（对应 quickstart.mjs 的 IIFE 初始提示）
_ = Task.Run(async () =>
{
    try
    {
        Console.Write(Blue("👤 消息 (esc中断): "));
        var input = Console.ReadLine()?.Trim() ?? "";
        if (input == "exit" || input == "quit") { conversationTcs.TrySetResult(); return; }
        if (!string.IsNullOrEmpty(input)) await SendInputAsync(input);

        // 后续轮次由 state:update idle 驱动（对应 quickstart.mjs 的 state:update 回调）
        while (!conversationTcs.Task.IsCompleted)
        {
            Console.Write(Blue("\n👤 消息 (esc中断): "));
            input = Console.ReadLine()?.Trim() ?? "";
            if (input == "exit" || input == "quit") { conversationTcs.TrySetResult(); return; }
            if (!string.IsNullOrEmpty(input)) await SendInputAsync(input);
        }
    }
    catch (Exception ex)
    {
        conversationTcs.TrySetException(ex);
    }
});

try
{
    await conversationTcs.Task;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"[Error] {ex.Message}");
}

Console.WriteLine("\n=== 会话结束 ===");

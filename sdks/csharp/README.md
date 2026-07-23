# Sema C# SDK

[Sema Code Core](https://github.com/midea-ai/sema-code-core) 的官方 C# SDK：一个事件驱动的 AI 编程助手核心引擎，支持多代理协作、Skill 扩展、Plan 模式任务规划等能力。SDK 内嵌 core 运行时（sidecar），`dotnet add package` 后开箱即用，原生 async/await。

## 安装

```bash
dotnet add package Semacore
```

要求：.NET 8.0+，本机 Node.js ≥ 18（core 运行时依赖）。

## 快速开始

```csharp
using Semacore;
using Semacore.Types;

await using var core = await SemaCore.Start(new SemaCoreConfig { WorkingDir = "/path/to/your/project" });
var session = await core.CreateSession();
session.On("message:text:chunk", d => Console.Write(SemaJson.Str(d, "delta")));

var done = new TaskCompletionSource<object?>(TaskCreationOptions.RunContinuationsAsynchronously);
session.On("state:update", d =>
{
    if (SemaJson.Str(d, "state") == "idle") done.TrySetResult(null);
});

await session.ProcessUserInput("你好");
await done.Task; // 等回复完成再关（await using 会自动关闭 core）
Console.WriteLine();
```

模型配置与更多用法见 [文档](https://midea-ai.github.io/sema-code-core)，完整示例见 [example/csharp-demo](https://github.com/midea-ai/sema-code-core/tree/main/example/csharp-demo)（交互式 CLI 与一次性执行）。

## License

[MIT](https://github.com/midea-ai/sema-code-core/blob/main/LICENSE)

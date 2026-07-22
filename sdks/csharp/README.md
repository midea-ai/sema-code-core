# Sema C# SDK

[Sema Code Core](https://github.com/midea-ai/sema-code-core) 的官方 C# SDK：一个事件驱动的 AI 编程助手核心引擎，支持多代理协作、Skill 扩展、Plan 模式任务规划等能力。SDK 内嵌 core 运行时（sidecar），加一个依赖即开箱即用；方法名/事件名/类型（`Semacore.Types`、`Semacore.Events` 下的强类型 DTO）与 sema-core、Python / Java SDK 完全一致，原生 async/await。

## 安装

```bash
dotnet add package Semacore
```

要求：.NET 8.0+，Node.js ≥ 18（SDK 本地优先探测 PATH 与 `~/.sema/node`，未找到时自动从 nodejs.org 下载到 `~/.sema/node`；也可设 `SEMA_NODE_PATH` 显式指定，或用 `SEMA_NODE_BASE_URL` 指镜像）。

## 快速开始

```csharp
using Semacore;
using Semacore.Types;

await using var core = await SemaCore.Start(new SemaCoreConfig { WorkingDir = "/path/to/your/project" });
var session = await core.CreateSession();
session.On("message:text:chunk", d => Console.Write(SemaJson.Str(d, "delta")));
await session.ProcessUserInput("你好");
```

模型配置与更多用法见 [文档](https://midea-ai.github.io/sema-code-core)，完整示例见 [example/csharp-demo](https://github.com/midea-ai/sema-code-core/tree/main/example/csharp-demo)（交互式 CLI 与一次性执行）。

## License

[MIT](https://github.com/midea-ai/sema-code-core/blob/main/LICENSE)

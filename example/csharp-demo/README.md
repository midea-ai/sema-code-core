# sema-core C# Demo

`example/demo`（Node 示例）的 C# 镜像，依赖官方 C# SDK（`Semacore`）。方法名（首字母大写机械映射）、参数名、事件名与 Node 版一致：

| 入口 | Node 版 | C# 版 |
|---|---|---|
| 交互式 CLI | `demo/src/cli.ts` | `Cli.cs`（`dotnet run --` 缺省入口） |
| 一次性执行（非交互） | `demo/src/run.ts` | `Run.cs`（`dotnet run -- run ...`） |
| 类型导入冒烟 | — | `Test.cs`（`dotnet run -- test`，≙ java-demo `Test.java`） |

```csharp
// 起步代码与 Node 逐行对照（sidecar 内嵌在 SDK 程序集里，自动释放拉起，无需任何路径配置）：
using Semacore;                                                   // ≙ import { SemaCore } from 'sema-core'
using Semacore.Types;                                             // ≙ import { ... } from 'sema-core/types'

var core = await SemaCore.Start(new SemaCoreConfig
    { WorkingDir = dir });                                        // ≙ new SemaCore({workingDir})
var session = await core.CreateSession();                        // ≙ await core.createSession()
session.On("message:text:chunk", d => ...);                     // ≙ session.on('message:text:chunk', ...)
await session.ProcessUserInput("你好");                           // ≙ session.processUserInput('你好')
await core.Close();                                               // ≙ await core.dispose()
```

## 前置条件

- .NET SDK 8.0+；Node ≥18（SDK 本地优先探测，探测不到自动下载到 `~/.sema/node`）
- 模型配置 `~/.sema/model.conf`（sema-core 自动读取，demo 代码不涉及模型配置；格式见 [`example/demo/README.md`](../demo/README.md)）

## 安装 SDK

本 demo 工程已引用 SDK，dotnet 会自动还原；自己的项目里这样引入：

```bash
dotnet add package Semacore --version 2.0.9
```

## 运行

```bash
cd example/csharp-demo
dotnet run -- /path/to/project               # 交互式 CLI，新建会话（≙ npm run cli）
dotnet run -- /path/to/project <会话id>       # 加载历史会话
dotnet run -- run /path/to/project "列出 src 结构" verbose   # 一次性执行（≙ npm run exec）
dotnet run -- test                           # 类型导入冒烟
```

交互方式与 Node 版一致：直接输入消息回车对话（如"你好"），权限询问输 `y`/`n`，`esc`/`Ctrl-C` 第一次中断当前轮、第二次退出，输入 `exit`/`quit` 结束。

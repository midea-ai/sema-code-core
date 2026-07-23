# sema-core C# Demo

## 前置条件

- .NET SDK 8.0+；Node ≥18（SDK 本地优先探测，探测不到自动下载到 `~/.sema/node`）
- 模型配置 `~/.sema/model.conf`（sema-core 自动读取，demo 代码不涉及模型配置；格式见 [`模型配置`](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model?id=%E6%8C%81%E4%B9%85%E5%8C%96)）

## 安装 Semacore

demo 工程已引用 SDK，dotnet 会自动从 NuGet 还原；自己的项目里这样引入：

```bash
dotnet add package Semacore
```

## 运行

```bash
cd example/csharp-demo
dotnet run -- /path/to/project               # 交互式 CLI，新建会话
dotnet run -- /path/to/project <会话id>       # 加载历史会话
dotnet run -- exec /path/to/project "列出 src 结构" verbose   # 一次性执行
```

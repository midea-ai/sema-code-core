# Sema C# SDK

sema-core 的 C# SDK（NuGet `Semacore`）：gRPC 桥（`../shared/bridge/`）的薄客户端，typed DTO、原生 async/await，.NET 8+。core 只有 Node 一份实现，SDK 负责连接管理、指令/事件、sidecar 托管，不重写任何 core 逻辑。sidecar 内嵌在程序集里自动释放拉起，加一个 NuGet 依赖即开箱即用（Node 18+ 本地优先探测，探测不到自动下载到 `~/.sema/node`）。使用示例见 `example/csharp-demo`。

## 目录结构

```
sdks/csharp/
├── Semacore.csproj     # 包 Semacore；构建期生成 proto 代码并内嵌 sidecar
├── Types.cs           # 类型 DTO（≙ 'sema-core/types'：record + 对象初始化器 / enum，单文件聚合）
├── Events.cs          # 事件数据 DTO（≙ 'sema-core/event'）
├── Api/               # SemaCore / SemaSession（镜像 API，68 action 全量 1:1，async typed 返回）+ SemaJson / Json
├── Protocol/          # SemaBridgeClient / SemaBridgeException / Registration
├── Transport/         # BridgeConnection / SemaEvent / ConnectionState
└── Runtime/           # SidecarManager / NodeProvider（node 本地优先 → 缓存 → 按需下载）
```

proto 生成代码由 Grpc.Tools 构建期从 `../shared/proto/sema.proto` 生成到 `obj/`，不提交入仓（`Access=Internal`，protobuf 类型不泄漏到公共 API）；sidecar 由构建期从 `../shared/bridge/dist` 内嵌进程序集的 `sema-sidecar/`（缺失时 build 前置 Target 直接失败，≙ Java validate / Python 的 `embed_sidecar.py`）。

## 构建与打包

从仓库根目录开始，整段粘贴即可：

```bash
# ① 构建桥产物（sidecar 以此为准）
cd sdks/shared/bridge && npm install && npm run build

# ② 构建 SDK 并打 NuGet 包（自动生成 proto 代码 + 内嵌 sidecar）
cd ../../csharp && dotnet pack -c Release
```

成功后 `bin/Release/` 下应有 `Semacore.<版本号>.nupkg`，内含 `sema-sidecar/server.js`。

## 发布

发到 nuget.org。一次性准备：[nuget.org](https://www.nuget.org) 登录后生成 API key（Push 权限、Glob `Semacore*`）。

之后每次发布一条命令：

```bash
dotnet nuget push bin/Release/Semacore.<版本号>.nupkg --source https://api.nuget.org/v3/index.json --api-key <API_KEY>
```

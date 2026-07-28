# Java / Python / C# SDK

sema-core 提供 Java / Python / C# 官方 SDK。core 只有 Node 一份实现,SDK 是 gRPC 桥的薄客户端(对标 Playwright 模式):只封装连接管理、指令/事件、类型和 sidecar 托管,不重写任何 core 逻辑。方法名、参数、事件名与 Node 版 sema-core 完全一致,跨语言 API 对照见 [API 与事件对照](wiki/sdk/api-reference)。

## 架构

```
宿主应用 (Java / Python / C# / ...)
    ↕ 各语言 SDK(api / protocol / transport / runtime 四层,互为镜像)
    ↕ gRPC 双向流 (sema.proto)
Node.js gRPC 桥(sidecar,由 SDK 自动拉起)
    ↕ 进程内调用
sema-core (npm 包)
```

- **api**:`SemaCore` / `SemaSession` 镜像 API,用法 ≈ Node
- **protocol**:指令/响应匹配、事件分发(`on` / `once` / `waitFor`)
- **transport**:gRPC 双向流、断线重连、就绪前缓冲、多连接
- **runtime**:sidecar 托管(自动释放内嵌桥产物并拉起;Node 供应走「本地探测 → `~/.sema/node` 缓存 → 按需下载」,内网可用 `SEMA_NODE_BASE_URL` 指镜像)

## 安装

**Node.js(npm)**:无需 SDK,直接使用 core 本体,见[快速开始](wiki/getting-started/quick-start):

```bash
npm install sema-core
```

**Java(Maven Central,17+)**:

```xml
<dependency>
  <groupId>io.github.midea-ai</groupId>
  <artifactId>sema-core</artifactId>
  <version>{版本号}</version>
</dependency>
```

**Python(PyPI,3.10+)**:

```bash
pip install sema-core
```

**C#(NuGet,.NET 8+)**:

```bash
dotnet add package Semacore
```

## 生命周期:单客户端 vs 多客户端

**核心原则:谁持有桥谁关。** `start()` 托管的实例 `close()` 会级联杀桥;`attach` 的只断自己连接,桥归 `SidecarManager` 持有方统一关。

- **单客户端**(脚本 / 后端,最常见):`start()` 托管 sidecar,`close()` 断连接并杀桥,一步到位。
- **多客户端**(一个进程多面板复用一个桥,如 IDE 插件):持有方用 `SidecarManager` 起桥,各面板 `attach` 到同一个桥、共享同一个 core;各面板 `close()` 只断自己连接,最后 `sidecar.close()` 才杀桥。

Python 示例(Java / C# 同构):

```python
# 单客户端:start 托管,close 一步关连接 + 杀桥
core = await SemaCore.start({"workingDir": project_dir})
...
await core.close()

# 多客户端:SidecarManager 持有桥,各面板 attach,退出时统一杀桥
async with SidecarManager(working_dir=project_dir) as sidecar:
    core_a = await SemaCore.attach(sidecar.new_client())   # 面板 A
    core_b = await SemaCore.attach(sidecar.new_client())   # 面板 B
    ...
    await core_a.close()      # 只断 A 的连接(桥还在)
    await core_b.close()      # 只断 B 的连接(桥还在)
# 离开 with → sidecar.close() 才 SIGTERM 杀桥
```

## 可运行示例

各语言完整示例见仓库 [`example/`](https://github.com/midea-ai/sema-code-core/tree/main/example) 目录下的 `java-demo` / `python-demo` / `csharp-demo`。

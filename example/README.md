# sema-core 集成示例

本目录汇集 sema-core 的多种集成方式：Node.js 直接集成，以及跨语言集成。

**跨语言强烈推荐 gRPC** —— API 与事件完整覆盖 sema-core 能力，强类型 proto 契约 + 官方多语言 codegen，且已有成熟工程在生产使用：JetBrains 插件的 sidecar 即基于本套 sema-grpc（[midea-ai/sema-code-vscode-extension](https://github.com/midea-ai/sema-code-vscode-extension/tree/main/jetbrains-plugin)）。

> WebSocket 桥接（`sema-bridge`）是早期示例，很久未更新、API 与事件均不完整，仅作最简参考保留，**后续不再更新**。新接入请直接用 gRPC。

## 目录结构

```
example/
├── quickstart.mjs            # Node.js 直接集成（无需桥接）
├── demo/                     # TypeScript 直接集成示例（交互式 CLI + 一次性执行）
│
├── sema-grpc/                # 桥接服务端 ─ gRPC（★ 跨语言推荐，API/事件完整）
├── sema-bridge/              # 桥接服务端 ─ WebSocket（早期示例，不再更新）
└── sema-bridge-clients/      # 客户端示例（C# / Java / Python，连接 sema-bridge）
```

## 选择集成方式

| 场景 | 方式 | 入口 |
|---|---|---|
| **跨语言（C# / Java / Kotlin / Python…），推荐** | **gRPC 桥接** | **[sema-grpc](sema-grpc/README.md)** |
| Node.js 项目，快速上手 | 直接集成 | [`quickstart.mjs`](#nodejs-直接集成) |
| Node.js / TypeScript，需要交互式 CLI 或一次性执行 | 直接集成 | [demo](demo/README.md) |
| 跨语言，仅需最简 WebSocket 参考（不再更新、不完整） | WebSocket 桥接 | [sema-bridge](sema-bridge/README.md) + [sema-bridge-clients](sema-bridge-clients/README.md) |

> **为什么跨语言选 gRPC**
> - **API 与事件完整**：sema-core 的全部能力（会话交互 + 模型 / 工具 / 插件 / MCP / Cron / Agents / Skills / Commands / Memory 等配置面 + 后台任务）都通过 gRPC 暴露，事件亦保持 core 原始事件名。
> - **强类型契约**：`proto` 一键 `protoc` 生成 Java / Kotlin / C# / Python / Go 客户端，免手写 JSON 序列化与事件分发。
> - **成熟工程背书**：JetBrains 插件的 sidecar 即基于本套 sema-grpc（见上方链接），已在生产运行。

## 快速启动

> 启动前先按各示例说明填好 `workingDir` 和 `apiKey`。

**场景 1 ─ Node.js 直接集成**

```bash
cd example
node quickstart.mjs
```

**场景 2 ─ TypeScript 交互式 CLI / 一次性执行**

```bash
cd example/demo
npm install
npm run cli /path/to/your/project              # 交互式 CLI
npm run exec /path/to/your/project "列出 src 结构"   # 一次性执行
```

**场景 3 ─ 跨语言（gRPC，推荐）**

```bash
# 启动 gRPC 桥接服务（默认端口 3766）
cd example/sema-grpc && npm install && npm run build && npm start
# 另开终端，执行前修改 api_key 和 代码库路径
cd example/sema-grpc && node quickstart-grpc.mjs
```

> 其它语言（C# / Java / Kotlin / Python…）：用 `example/sema-grpc/proto/sema.proto` 生成对应客户端即可，可参考 JetBrains 插件的 Kotlin/Java 实现（[midea-ai/sema-code-vscode-extension](https://github.com/midea-ai/sema-code-vscode-extension/tree/main/jetbrains-plugin)）。

**场景 4 ─ 跨语言（WebSocket，早期示例，不再更新）**

```bash
# 1) 启动桥接服务（默认端口 3765）
cd example/sema-bridge && npm install && npm run build && npm start

# 2) 另开终端，运行任一客户端，执行前修改 api_key 和 代码库路径
cd example/sema-bridge-clients/sema-python-demo && pip install -r requirements.txt && python main.py
cd example/sema-bridge-clients/sema-csharp-demo && dotnet run
cd example/sema-bridge-clients/sema-java-demo   && mvn compile exec:java -Dexec.mainClass=com.semademo.Main
```

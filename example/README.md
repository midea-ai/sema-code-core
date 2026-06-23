# sema-core 集成示例

本目录汇集 sema-core 的多种集成方式：Node.js 直接集成，以及通过 WebSocket / gRPC 桥接的跨语言（C# / Java / Python）集成。

## 目录结构

```
example/
├── quickstart.mjs            # Node.js 直接集成（无需桥接）
├── demo/                     # TypeScript 直接集成示例（交互式 CLI + 一次性执行）
│
├── sema-grpc/                # 桥接服务端 ─ gRPC
├── sema-bridge/              # 桥接服务端 ─ WebSocket
└── sema-bridge-clients/      # 客户端示例（C# / Java / Python，连接 sema-bridge）
```

## 选择集成方式

| 场景 | 方式 | 入口 |
|---|---|---|
| Node.js 项目，快速上手 | 直接集成 | [`quickstart.mjs`](#nodejs-直接集成) |
| Node.js / TypeScript，需要交互式 CLI 或一次性执行 | 直接集成 | [demo](demo/README.md) |
| C# / Java / Python，走 WebSocket | 桥接 | [sema-bridge](sema-bridge/README.md) + [sema-bridge-clients](sema-bridge-clients/README.md) |
| 对 gRPC 有需求 | 桥接 | [sema-grpc](sema-grpc/README.md) |

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

**场景 3 ─ 跨语言（WebSocket）**

```bash
# 1) 启动桥接服务（默认端口 3765）
cd example/sema-bridge && npm install && npm run build && npm start

# 2) 另开终端，运行任一客户端，执行前修改 api_key 和 代码库路径
cd example/sema-bridge-clients/sema-python-demo && pip install -r requirements.txt && python main.py
cd example/sema-bridge-clients/sema-csharp-demo && dotnet run
cd example/sema-bridge-clients/sema-java-demo   && mvn compile exec:java -Dexec.mainClass=com.semademo.Main
```

**场景 4 ─ 跨语言（gRPC）**

```bash
# 启动 gRPC 桥接服务（默认端口 3766）
cd example/sema-grpc && npm install && npm run build && npm start
# 另开终端，执行前修改 api_key 和 代码库路径
cd example/sema-grpc && node quickstart-grpc.mjs
```

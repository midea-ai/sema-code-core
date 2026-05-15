# sema-core 跨语言集成

通过 WebSocket 桥接集成 sema-core 的多语言示例项目，提供 C#、Java、Python 三个客户端实现。

## 架构

**WebSocket 方式（sema-bridge）：**
```
客户端应用 (C# / Java / Python)
    ↕ WebSocket (ws://localhost:3765)
Node.js 桥接服务 (sema-bridge)
    ↕ 内部调用
sema-core (npm 包)
```

**gRPC 方式（sema-grpc）：**
```
客户端应用 (C# / Java / Python / ...)
    ↕ gRPC 双向流 (grpc://localhost:3766)
Node.js gRPC 服务 (sema-grpc)
    ↕ 内部调用
sema-core (npm 包)
```

## 项目结构

```
example/
├── quickstart.mjs            # Node.js 直接集成（无需桥接）
│
├── sema-bridge/              # 桥接服务端 ─ WebSocket
├── sema-grpc/                # 桥接服务端 ─ gRPC
│
├── sema-csharp-demo/         # 客户端示例 ─ C#    (连接 sema-bridge)
├── sema-java-demo/           # 客户端示例 ─ Java   (连接 sema-bridge)
└── sema-python-demo/         # 客户端示例 ─ Python (连接 sema-bridge)
```

## 环境要求

- **Node.js**（桥接服务必需）
- **C# 客户端**：.NET SDK
- **Java 客户端**：JDK 17+、Maven
- **Python 客户端**：Python 3.10+

## Node.js 直接集成（quickstart.mjs）

如果你使用 Node.js 开发，可以直接使用 sema-core，无需桥接服务。

修改 workingDir 和 apiKey：

```javascript
// example/quickstart.mjs

workingDir: '/path/to/your/project', // Agent 将操作的目标代码仓库路径

apiKey: "sk-",  // 替换为你的 API Key
```

更多模型配置选项，请参见[模型管理](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model)

运行：

```bash
cd example
node quickstart.mjs
```

## 跨语言集成启动步骤

### 1. 启动 WebSocket 桥接服务

```bash
cd sema-bridge
npm install
npm run build
npm start
```

环境变量：
- `SEMA_BRIDGE_PORT`：端口，默认 `3765`
- `SEMA_WORKING_DIR`：工作目录，默认当前目录

### 2. 运行 C# Demo

修改 workingDir 和 apiKey：

```csharp
// sema-csharp-demo/Program.cs

WorkingDir = "/path/to/your/project", // Agent 将操作的目标代码仓库路径

apiKey = "sk-",  // 替换为你的 API Key
```
更多模型配置选项，请参见[模型管理](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model)

运行：

```bash
cd sema-csharp-demo
dotnet run
```

### 3. 运行 Java Demo

修改 workingDir 和 apiKey：

```java
// sema-java-demo/src/main/java/com/semademo/Main.java

.workingDir("/path/to/your/project") // Agent 将操作的目标代码仓库路径

modelConfig.put("apiKey", "sk-");  // 替换为你的 API Key
```
更多模型配置选项，请参见[模型管理](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model)

运行：

```bash
cd sema-java-demo

# 打包（含所有依赖的 fat-jar）
mvn package -q

# 运行
java -jar target/sema-java-demo-1.0-SNAPSHOT-jar-with-dependencies.jar
```

或直接通过 Maven 运行（无需打包）：

```bash
cd sema-java-demo
mvn compile exec:java -Dexec.mainClass=com.semademo.Main
```

### 4. 运行 Python Demo

修改 working_dir 和 apiKey：

```python
# sema-python-demo/main.py

working_dir="/path/to/your/project"  # Agent 将操作的目标代码仓库路径

"apiKey": "sk-",  # 替换为你的 API Key
```
更多模型配置选项，请参见[模型管理](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model)

运行：

```bash
cd sema-python-demo

# 安装依赖
pip install -r requirements.txt

# 运行
python main.py
```

## gRPC 桥接服务（sema-grpc）

除 WebSocket 外，还提供 gRPC 双向流桥接，适用于对 gRPC 有需求的场景。详见 [sema-grpc/README.md](sema-grpc/README.md)。

```bash
cd sema-grpc
npm install
npm run build
npm start
```

环境变量：
- `SEMA_BRIDGE_PORT`：端口，默认 `3766`
- `SEMA_WORKING_DIR`：工作目录，默认当前目录

## 客户端实现对比

| 特性 | C# | Java | Python |
|---|---|---|---|
| WebSocket | `ClientWebSocket` | OkHttp `WebSocket` | `websockets` |
| JSON | Newtonsoft.Json | Jackson | 内置 `json` |
| 异步 | `Task` / `async-await` | `CompletableFuture` | `asyncio` |
| 信号量 | `SemaphoreSlim` | `Semaphore` | `asyncio.Event` |
| 事件回调 | `Action<JToken?>` | `Consumer<JsonNode>` | `Callable` |
| 构建工具 | `dotnet` | Maven | pip |

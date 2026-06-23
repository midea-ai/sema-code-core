# sema-bridge-clients

连接 [sema-bridge](../sema-bridge/README.md)（WebSocket 桥接服务）的多语言客户端示例，提供 C#、Java、Python 三个实现。

## 目录结构

```
sema-bridge-clients/
├── sema-csharp-demo/     # C#
├── sema-java-demo/       # Java
└── sema-python-demo/     # Python
```

## 前置条件

运行任意客户端前，请先启动 WebSocket 桥接服务（默认 `ws://localhost:3765`）：

```bash
cd example/sema-bridge && npm install && npm run build && npm start
```

更多说明详见 [sema-bridge/README.md](../sema-bridge/README.md)。

各客户端示例都需要修改两处：`workingDir`（Agent 操作的目标代码仓库路径）和 `apiKey`。更多模型配置选项，请参见[模型管理](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model)。

## C# Demo

环境要求：.NET SDK

修改配置：

```csharp
// sema-csharp-demo/Program.cs
WorkingDir = "/path/to/your/project", // Agent 将操作的目标代码仓库路径
apiKey = "sk-your-api-key",           // 替换为你的 API Key
```

运行：

```bash
cd example/sema-bridge-clients/sema-csharp-demo
dotnet run
```

## Java Demo

环境要求：JDK 17+、Maven

修改配置：

```java
// sema-java-demo/src/main/java/com/semademo/Main.java
.workingDir("/path/to/your/project")  // Agent 将操作的目标代码仓库路径
modelConfig.put("apiKey", "sk-your-api-key");  // 替换为你的 API Key
```

运行（打包为含全部依赖的 fat-jar）：

```bash
cd example/sema-bridge-clients/sema-java-demo
mvn package -q
java -jar target/sema-java-demo-1.0-SNAPSHOT-jar-with-dependencies.jar
```

或直接通过 Maven 运行（无需打包）：

```bash
cd example/sema-bridge-clients/sema-java-demo
mvn compile exec:java -Dexec.mainClass=com.semademo.Main
```

## Python Demo

环境要求：Python 3.10+

修改配置：

```python
# sema-python-demo/main.py
working_dir="/path/to/your/project"  # Agent 将操作的目标代码仓库路径
"apiKey": "sk-your-api-key",         # 替换为你的 API Key
```

运行：

```bash
cd example/sema-bridge-clients/sema-python-demo
pip install -r requirements.txt
python main.py
```

## 客户端实现对比

| 特性 | C# | Java | Python |
|---|---|---|---|
| WebSocket | `ClientWebSocket` | OkHttp `WebSocket` | `websockets` |
| JSON | Newtonsoft.Json | Jackson | 内置 `json` |
| 异步 | `Task` / `async-await` | `CompletableFuture` | `asyncio` |
| 信号量 | `SemaphoreSlim` | `Semaphore` | `asyncio.Event` |
| 事件回调 | `Action<JToken?>` | `Consumer<JsonNode>` | `Callable` |
| 构建工具 | `dotnet` | Maven | pip |

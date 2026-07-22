# sema-core 集成示例

Node.js 直接集成，以及 Java / Python / C# 官方 SDK 集成（方法名、事件名与 Node 版完全一致）。

## 目录结构

```
example/
├── quickstart.mjs            # Node.js 直接集成（无需桥接）
├── demo/                     # TypeScript 示例（交互式 CLI + 一次性执行）
├── java-demo/                # Java 官方 SDK 示例（demo 的 Java 镜像）
├── python-demo/              # Python 官方 SDK 示例（demo 的 Python 镜像）
└── csharp-demo/              # C# 官方 SDK 示例（demo 的 C# 镜像）
```

## 安装与运行

模型配置 `~/.sema/model.conf`（各语言 sema-core 自动读取，格式见 [demo/README.md](demo/README.md)）。

**Node.js / TypeScript**

```bash
npm install sema-core
```

```bash
cd example && node quickstart.mjs                    # 最小起步
cd example/demo && npm install
npm run cli /path/to/your/project                    # 交互式 CLI
npm run exec /path/to/your/project "列出 src 结构"    # 一次性执行
```

**Java**（17+，SDK 由 Maven 自动从 Maven Central 拉取）

```xml
<dependency>
  <groupId>io.github.midea-ai</groupId>
  <artifactId>sema-core</artifactId>
  <version>2.0.9</version>
</dependency>
```

```bash
cd example/java-demo
mvn -q compile exec:java -Dexec.args="/path/to/your/project"
```

**Python**（3.10+）

```bash
pip install sema-core
```

```bash
cd example/python-demo
python cli.py /path/to/your/project
```

**C#**（.NET 8+）

```bash
dotnet add package Semacore --version 2.0.9
```

```bash
cd example/csharp-demo
dotnet run -- /path/to/your/project
```

**其它语言（Kotlin / Go…）**：用 `sdks/shared/proto/sema.proto` 自行生成 gRPC 客户端，见 [sdks/shared/bridge](../sdks/shared/bridge/README.md)。

各 demo 的完整用法（一次性执行、加载历史会话等）见对应目录的 README。

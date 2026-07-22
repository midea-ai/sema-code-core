# Sema Java SDK

[Sema Code Core](https://github.com/midea-ai/sema-code-core) 的官方 Java SDK：一个事件驱动的 AI 编程助手核心引擎，支持多代理协作、Skill 扩展、Plan 模式任务规划等能力。SDK 内嵌 core 运行时（sidecar），加一个依赖即开箱即用；方法名/事件名/类型（`semacore.type`、`semacore.event` 下的强类型 DTO）与 sema-core、Python SDK 完全一致，请求方法同步阻塞、直接返回结果。

## 安装

```xml
<dependency>
  <groupId>io.github.midea-ai</groupId>
  <artifactId>sema-core</artifactId>
  <version>2.0.9</version>
</dependency>
```

要求：Java 17+，Node.js ≥ 18（SDK 本地优先探测 PATH 与 `~/.sema/node`，未找到时自动从 nodejs.org 下载到 `~/.sema/node`；也可设 `SEMA_NODE_PATH` 显式指定，或用 `SEMA_NODE_BASE_URL` 指镜像）。

## 快速开始

```java
import semacore.*;
import semacore.type.SemaCoreConfig;

try (SemaCore core = SemaCore.start(SemaCoreConfig.builder().workingDir("/path/to/your/project").build())) {
    SemaSession session = core.createSession();
    session.on("message:text:chunk", d -> System.out.print(SemaJson.str(d, "delta")));
    session.processUserInput("你好");
}
```

模型配置与更多用法见 [文档](https://midea-ai.github.io/sema-code-core)，完整示例见 [example/java-demo](https://github.com/midea-ai/sema-code-core/tree/main/example/java-demo)（交互式 CLI 与一次性执行）。

## License

[MIT](https://github.com/midea-ai/sema-code-core/blob/main/LICENSE)

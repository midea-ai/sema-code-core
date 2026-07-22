# sema-core Java Demo

`example/demo`（Node 示例）的 Java 镜像，依赖官方 Java SDK（`sema-core`）。方法名、参数名、事件名与 Node 版完全一致：

| 入口 | Node 版 | Java 版 |
|---|---|---|
| 交互式 CLI | `demo/src/cli.ts` | `Main.java` |
| 一次性执行（非交互） | `demo/src/run.ts` | `Run.java` |

```java
// 起步代码与 Node 逐行对照（sidecar 内嵌在 SDK jar，自动释放拉起，无需任何路径配置）：
SemaCore core = SemaCore.start(SemaCoreConfig.builder().workingDir(dir).build());  // ≙ new SemaCore({workingDir})
SemaSession session = core.createSession();                  // ≙ await core.createSession()（同步直接返回，无 join）
session.on("message:text:chunk", d -> ...);                 // ≙ session.on('message:text:chunk', ...)
session.processUserInput("你好");                             // ≙ session.processUserInput('你好')
core.close();                                                 // ≙ await core.dispose()
```

## 前置条件

- JDK 17+、Maven 3.6+
- Node ≥18（SDK 自动探测本机 PATH 与 `~/.sema/node`，未找到时自动下载到 `~/.sema/node`；也可设 `SEMA_NODE_PATH` 指定）
- 模型配置 `~/.sema/model.conf`（sema-core 自动读取，demo 代码不涉及模型配置；格式见 [`example/demo/README.md`](../demo/README.md)）

## 安装 SDK

本 demo 的 `pom.xml` 已声明依赖，Maven 会自动从 Maven Central 拉取；自己的项目里这样引入：

```xml
<dependency>
  <groupId>io.github.midea-ai</groupId>
  <artifactId>sema-core</artifactId>
  <version>2.0.9</version>
</dependency>
```

## 运行

```bash
# -q 必加，否则 Maven 日志会混入流式输出
cd example/java-demo
# 交互式 CLI（≙ npm run cli）
mvn -q compile exec:java -Dexec.args="/path/to/project"            # 新建会话
mvn -q compile exec:java -Dexec.args="/path/to/project <会话id>"    # 加载历史会话
# 一次性执行（≙ npm run exec）：档位 verbose|medium|simple|minimal，缺省 verbose
mvn -q compile exec:java -Dexec.mainClass=com.sema.example.demo.Run \
    -Dexec.args="/path/to/project '列出 src 结构' verbose"
```

交互方式与 Node 版一致：直接输入消息回车对话（如"你好"），权限询问输 `y`/`n`，`esc`/`Ctrl-C` 第一次中断当前轮、第二次退出，输入 `exit`/`quit` 结束。

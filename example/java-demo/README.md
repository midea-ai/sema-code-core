# sema-core Java Demo

## 前置条件

- JDK 17+、Maven 3.6+；Node ≥18（SDK 本地优先探测，探测不到自动下载到 `~/.sema/node`）
- 模型配置 `~/.sema/model.conf`（sema-core 自动读取，demo 代码不涉及模型配置；格式见 [`模型配置`](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model?id=%E6%8C%81%E4%B9%85%E5%8C%96)）

## 安装 sema-core

demo 的 `pom.xml` 已声明依赖，Maven 会自动从 Maven Central 拉取；自己的项目里这样引入：

```xml
<dependency>
  <groupId>io.github.midea-ai</groupId>
  <artifactId>sema-core</artifactId>
  <version>2.0.10</version>
</dependency>
```

## 运行

```bash
# -q 必加，否则 Maven 日志会混入流式输出
cd example/java-demo
mvn -q compile exec:java -Dexec.args="/path/to/project"            # 交互式 CLI，新建会话
mvn -q compile exec:java -Dexec.args="/path/to/project <会话id>"    # 加载历史会话
mvn -q compile exec:java -Dexec.mainClass=com.sema.example.demo.Run \
    -Dexec.args="/path/to/project '列出 src 结构' verbose"           # 一次性执行
```

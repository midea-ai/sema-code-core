# Sema Java SDK

sema-core 的 Java SDK（Maven `sema-core`）：gRPC 桥（`../shared/bridge/`）的薄客户端，typed DTO、请求方法同步阻塞直接返回，Java 17+。core 只有 Node 一份实现，SDK 负责连接管理、指令/事件、sidecar 托管，不重写任何 core 逻辑。sidecar 内嵌在 jar 里自动释放拉起，加一个 Maven 依赖即开箱即用（Node 18+ 本地优先探测，探测不到自动下载到 `~/.sema/node`）。使用示例见 `example/java-demo`。

## 目录结构

```
sdks/java/
├── pom.xml                                # 包坐标；构建期生成 proto 代码并内嵌 sidecar
└── src/
    ├── main/java/semacore/
    │   ├── SemaCore / SemaSession        # 镜像 API（68 action 全量 1:1，同步 typed 返回）
    │   ├── type/         # 类型 DTO（≙ 'sema-core/types'：record + builder / enum / sealed）
    │   ├── event/        # 事件数据 DTO（≙ 'sema-core/event'）
    │   ├── protocol/     # SemaBridgeClient / SemaBridgeException / Registration
    │   ├── transport/    # BridgeConnection / SemaEvent / ConnectionState
    │   └── runtime/      # SidecarManager / NodeProvider（node 本地优先 → 缓存 → 按需下载）
```

proto 生成代码由构建期从 `../shared/proto/sema.proto` 生成到 `target/generated-sources/protobuf`，不提交入仓；sidecar 由构建期从 `../shared/bridge/dist` 内嵌进 jar 的 `sema-sidecar/`（缺失时 validate 阶段直接失败，≙ Python 的 `embed_sidecar.py`）。

## 构建与打包

从仓库根目录开始，整段粘贴即可：

```bash
# ① 构建桥产物（sidecar 以此为准）
cd sdks/shared/bridge && npm install && npm run build

# ② 构建 SDK 并安装到本地 Maven 仓库（自动生成 proto 代码 + 内嵌 sidecar）
cd ../../java && mvn -q -DskipTests clean install
```

成功后 `target/` 下应有 `sema-core-2.0.9.jar`，内含 `sema-sidecar/server.js`。

## 发布

发到 Maven Central（Central Portal）。一次性准备：

1. [central.sonatype.com](https://central.sonatype.com) 用 GitHub 账号登录（GitHub namespace 自动验证），生成 token 写入 `~/.m2/settings.xml`（`<server><id>central</id>` + token 用户名/密码）
2. 本机 GPG 密钥（Central 强制签名）：`gpg --gen-key`，公钥上传 `gpg --keyserver keyserver.ubuntu.com --send-keys <KEYID>`

之后每次发布一条命令：

```bash
mvn -q -DskipTests clean deploy -P release   # 签名 + sources/javadoc + 上传，最后到 Portal 网页点 Publish 生效
```

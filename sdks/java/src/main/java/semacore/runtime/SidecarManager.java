package semacore.runtime;

import semacore.SemaCore;
import semacore.protocol.SemaBridgeClient;
import semacore.transport.BridgeConnection;
import semacore.type.SemaCoreConfig;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.function.IntConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * sema-grpc sidecar（Node 进程）生命周期管理。
 *
 * <ul>
 *   <li><b>一个 SidecarManager = 一个 sidecar 进程</b>（共享同一 SemaCore + 会话池）；
 *       {@link #newConnection()} 可开任意多条独立 gRPC 连接（对应 JB 插件「一个 project
 *       一个 sidecar、每个面板一条连接」的模型）。</li>
 *   <li><b>启动异步且幂等</b>：{@link #start()} 拉起进程并等待 stdout 的
 *       {@code SEMA_BRIDGE_PORT_ACTUAL=<port>} 端口握手（SEMA_BRIDGE_PORT=0 由系统分配空闲端口，
 *       多实例不撞端口）。newConnection 预接 portFuture，进程就绪前的指令自动缓冲。</li>
 *   <li><b>sidecar 目录解析</b>：builder 显式指定 → SEMA_SIDECAR_DIR 环境变量 /
 *       sema.sidecar.dir 系统属性 → classpath {@code sema-sidecar/server.js} 释放到本地缓存
 *       （为三期「桥产物内嵌 SDK jar」预留，当前 jar 未内嵌）。</li>
 *   <li><b>Node 供应可插拔</b>：默认 {@link NodeProviders#system()} 走「本地优先 →
 *       {@code ~/.sema/node} 缓存 → 按需下载」；需要其他策略的宿主注入自己的
 *       {@link NodeProvider}。</li>
 * </ul>
 */
public final class SidecarManager implements AutoCloseable {

    private static final Pattern PORT_PATTERN = Pattern.compile("SEMA_BRIDGE_PORT_ACTUAL=(\\d+)");
    /** 与 SidecarProcess 兼容的三种产物布局：esbuild 单文件 / dist / 旧 tsc。 */
    private static final String[] SERVER_JS_CANDIDATES = {"server.js", "dist/server.js", "dist/src/server.js"};
    private static final System.Logger LOG = System.getLogger(SidecarManager.class.getName());

    private final Path sidecarDir;
    private final Path workingDir;
    private final NodeProvider nodeProvider;
    private final Map<String, String> extraEnv;
    private final List<Path> prependPath;
    private final Path extractDir;
    private final Consumer<String> logConsumer;
    private final IntConsumer onExit;

    private final CompletableFuture<Integer> portFuture = new CompletableFuture<>();
    private volatile Process process;
    private volatile boolean started;
    private volatile boolean stopped;

    private SidecarManager(Builder b) {
        this.sidecarDir = b.sidecarDir;
        this.workingDir = b.workingDir != null ? b.workingDir : Path.of(System.getProperty("user.dir"));
        this.nodeProvider = b.nodeProvider != null ? b.nodeProvider : NodeProviders.system();
        this.extraEnv = b.env;
        this.prependPath = b.prependPath;
        this.extractDir = b.extractDir != null ? b.extractDir
                : Path.of(System.getProperty("user.home"), ".sema", "java-sdk-sidecar");
        this.logConsumer = b.logConsumer;
        this.onExit = b.onExit;
    }

    public static Builder builder() {
        return new Builder();
    }

    // ── 生命周期 ─────────────────────────────────────────────────────────

    /**
     * 拉起 sidecar（异步、幂等），返回端口 future。boot（含 node 探测）在独立守护线程执行，
     * 不阻塞调用线程（IDE 宿主可在 EDT 安全调用）。
     */
    public synchronized CompletableFuture<Integer> start() {
        if (stopped) throw new IllegalStateException("SidecarManager 已停止");
        if (!started) {
            started = true;
            Thread t = new Thread(this::boot, "sema-sidecar-boot");
            t.setDaemon(true);
            t.start();
        }
        return portFuture;
    }

    /** 实际监听端口；未就绪时为 -1。 */
    public int port() {
        Integer p = portFuture.getNow(null);
        return p != null ? p : -1;
    }

    public boolean isRunning() {
        Process p = process;
        return p != null && p.isAlive();
    }

    /** 停止 sidecar 进程（3s 宽限后强杀）。 */
    public synchronized void stop() {
        stopped = true;
        Process p = process;
        process = null;
        if (p != null) {
            p.destroy();
            try {
                if (!p.waitFor(3, TimeUnit.SECONDS)) p.destroyForcibly();
            } catch (InterruptedException e) {
                p.destroyForcibly();
                Thread.currentThread().interrupt();
            }
        }
        if (!portFuture.isDone()) {
            portFuture.completeExceptionally(new IllegalStateException("sidecar 已停止"));
        }
    }

    @Override
    public void close() {
        stop();
    }

    // ── 连接工厂 ─────────────────────────────────────────────────────────

    /**
     * 预接本 sidecar 端口的连接 Builder（隐式触发 {@link #start()}）。
     * 进程就绪前即可 build + connect，指令自动缓冲。
     */
    public BridgeConnection.Builder connectionBuilder() {
        // thenApply 复制一层，防止连接侧误改共享 future
        return BridgeConnection.builder().portFuture(start().thenApply(p -> p));
    }

    /** 新开一条已启动的独立连接（每个 UI 面板 / 逻辑单元一条）。 */
    public BridgeConnection newConnection() {
        BridgeConnection conn = connectionBuilder().build();
        conn.connect();
        return conn;
    }

    /** 新开一条连接并包装为协议层客户端。 */
    public SemaBridgeClient newClient() {
        return new SemaBridgeClient(newConnection());
    }

    /**
     * 新开一条连接并初始化镜像 API 入口（≙ Node: {@code new SemaCore(config)}）。
     * init 非破坏式：sidecar 内 core 已存在时只做就绪确认，config 不覆盖已有配置。
     */
    public SemaCore newCore(SemaCoreConfig config) {
        return SemaCore.attach(newClient(), config);
    }

    // ── 启动实现 ─────────────────────────────────────────────────────────

    private void boot() {
        try {
            File serverJs = resolveServerJs();
            String searchPath = Provisioner.loginShellPath();
            if (searchPath == null || searchPath.isBlank()) searchPath = System.getenv("PATH");
            String node = nodeProvider.resolveNode();

            ProcessBuilder pb = new ProcessBuilder(node, serverJs.getAbsolutePath())
                    .directory(serverJs.getParentFile())
                    .redirectErrorStream(true);
            Map<String, String> env = pb.environment();
            // 0 = 系统分配空闲端口；宿主显式传 SEMA_BRIDGE_PORT 时尊重宿主
            env.putIfAbsent("SEMA_BRIDGE_PORT", "0");
            env.put("SEMA_WORKING_DIR", workingDir.toString());
            // 生命周期由本 manager 管（stop() 发 SIGTERM）：终端宿主的 Ctrl-C 会把 SIGINT 发给
            // 整个前台进程组，桥必须忽略 SIGINT，否则「第一次 Ctrl-C 只中断会话」的语义会被破坏
            env.put("SEMA_BRIDGE_PARENT_OWNED", "1");
            env.putAll(extraEnv);

            // 组装子进程 PATH：node 所在目录 + 宿主前置目录 > 登录 shell/现有 PATH。
            // 只前置到 sidecar 子进程，不修改系统环境（sema-core 再 spawn node / npx / rg 时按 PATH
            // 查找；rg 的探测/下载兜底由桥进程自己完成，见 shared/bridge/src/rg.ts）。
            String pathKey = env.keySet().stream()
                    .filter(k -> k.equalsIgnoreCase("PATH")).findFirst().orElse("PATH");
            StringBuilder path = new StringBuilder();
            File nodeDir = new File(node).getParentFile();
            if (nodeDir != null) path.append(nodeDir.getAbsolutePath()).append(File.pathSeparator);
            for (Path p : prependPath) path.append(p.toAbsolutePath()).append(File.pathSeparator);
            String existing = env.get(pathKey);
            if (searchPath != null && !searchPath.isBlank()) {
                path.append(searchPath);
                if (existing != null && !existing.isBlank() && !existing.equals(searchPath)) {
                    path.append(File.pathSeparator).append(existing);
                }
            } else if (existing != null && !existing.isBlank()) {
                path.append(existing);
            }
            env.put(pathKey, path.toString());

            Process proc = pb.start();
            process = proc;
            if (stopped) { // stop() 与 boot 竞态：立即回收
                proc.destroyForcibly();
                return;
            }
            proc.onExit().thenAccept(p -> {
                if (!portFuture.isDone()) {
                    portFuture.completeExceptionally(
                            new IllegalStateException("sidecar 进程退出前未上报端口（exit=" + p.exitValue() + "）"));
                }
                if (onExit != null) onExit.accept(p.exitValue());
            });

            // 本线程直接读 stdout：日志转 logConsumer，捕获端口握手行
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (logConsumer != null) logConsumer.accept(line);
                    if (!portFuture.isDone()) {
                        Matcher m = PORT_PATTERN.matcher(line);
                        if (m.find()) portFuture.complete(Integer.parseInt(m.group(1)));
                    }
                }
            }
        } catch (Throwable t) {
            if (!portFuture.isDone()) portFuture.completeExceptionally(t);
        }
    }

    /** 解析含 server.js 的 sidecar 目录并定位 server.js。 */
    private File resolveServerJs() throws IOException {
        Path dir = sidecarDir;
        if (dir == null) {
            String fromEnv = System.getenv("SEMA_SIDECAR_DIR");
            if (fromEnv == null) fromEnv = System.getProperty("sema.sidecar.dir");
            if (fromEnv != null && !fromEnv.isBlank()) dir = Path.of(fromEnv);
        }
        if (dir == null) dir = extractBundledSidecar();
        if (dir == null) {
            throw new IOException("未找到 sidecar：请通过 Builder#sidecarDir 或环境变量 SEMA_SIDECAR_DIR "
                    + "指向含 server.js 的 sema-grpc 目录");
        }
        for (String candidate : SERVER_JS_CANDIDATES) {
            File f = dir.resolve(candidate).toFile();
            if (f.isFile()) return f;
        }
        throw new IOException("sidecar 目录中未找到 server.js: " + dir.toAbsolutePath());
    }

    /** 从 classpath（sema-sidecar/server.js）释放内嵌 sidecar 到缓存目录；未内嵌时返回 null。 */
    private Path extractBundledSidecar() throws IOException {
        ClassLoader loader = getClass().getClassLoader();
        try (InputStream server = loader.getResourceAsStream("sema-sidecar/server.js")) {
            if (server == null) return null;
            Files.createDirectories(extractDir);
            Files.copy(server, extractDir.resolve("server.js"), StandardCopyOption.REPLACE_EXISTING);
        }
        try (InputStream proto = loader.getResourceAsStream("sema-sidecar/proto/sema.proto")) {
            if (proto != null) {
                Path protoDir = extractDir.resolve("proto");
                Files.createDirectories(protoDir);
                Files.copy(proto, protoDir.resolve("sema.proto"), StandardCopyOption.REPLACE_EXISTING);
            }
        }
        return extractDir;
    }

    // ── Builder ──────────────────────────────────────────────────────────

    public static final class Builder {
        private Path sidecarDir;
        private Path workingDir;
        private NodeProvider nodeProvider;
        private final Map<String, String> env = new LinkedHashMap<>();
        private final List<Path> prependPath = new java.util.ArrayList<>();
        private Path extractDir;
        private Consumer<String> logConsumer;
        private IntConsumer onExit;

        private Builder() {
        }

        /** 含 server.js 的 sema-grpc 产物目录（也可用 SEMA_SIDECAR_DIR 环境变量指定）。 */
        public Builder sidecarDir(Path dir) {
            this.sidecarDir = dir;
            return this;
        }

        /** Agent 操作的目标工程路径（SEMA_WORKING_DIR），默认当前目录。 */
        public Builder workingDir(Path dir) {
            this.workingDir = dir;
            return this;
        }

        /** Node 供应策略，默认 {@link NodeProviders#system()}（本地优先 → 缓存 → 按需下载）。 */
        public Builder nodeProvider(NodeProvider provider) {
            this.nodeProvider = provider;
            return this;
        }

        /** 附加/覆盖 sidecar 子进程环境变量。 */
        public Builder env(String key, String value) {
            this.env.put(Objects.requireNonNull(key), Objects.requireNonNull(value));
            return this;
        }

        /** 前置到子进程 PATH 的目录（如宿主准备好的 rg 目录），供 sema-core spawn 命中。 */
        public Builder prependPath(Path dir) {
            this.prependPath.add(Objects.requireNonNull(dir));
            return this;
        }

        /** classpath 内嵌 sidecar 的释放目录，默认 ~/.sema/java-sdk-sidecar。 */
        public Builder extractDir(Path dir) {
            this.extractDir = dir;
            return this;
        }

        /** sidecar stdout/stderr 行消费者（接宿主日志系统）。 */
        public Builder logConsumer(Consumer<String> consumer) {
            this.logConsumer = consumer;
            return this;
        }

        /** 进程退出回调（参数为退出码）；宿主可据此决定重启策略。 */
        public Builder onExit(IntConsumer callback) {
            this.onExit = callback;
            return this;
        }

        public SidecarManager build() {
            return new SidecarManager(this);
        }
    }
}

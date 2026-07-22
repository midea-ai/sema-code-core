package semacore.transport;

import com.sema.sdk.internal.grpc.BridgeCommand;
import com.sema.sdk.internal.grpc.BridgeEvent;
import com.sema.sdk.internal.grpc.SemaBridgeGrpc;
import io.grpc.ConnectivityState;
import io.grpc.ManagedChannel;
import io.grpc.okhttp.OkHttpChannelBuilder;
import io.grpc.stub.StreamObserver;

import java.time.Duration;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import java.util.function.IntFunction;

/**
 * sema-grpc 桥的传输层连接：一条 gRPC 双向流。
 *
 * <ul>
 *   <li><b>就绪前缓冲</b>：{@link #connect()} 后即可 {@link #send}，连接就绪前指令入队，就绪后按序 flush
 *       （对齐 JB 插件 Conn 模式，消除「指令早于连接就绪」竞态）。</li>
 *   <li><b>断线重连</b>：流断开后按指数退避自动重连（默认开启、无限次）；重连成功回到
 *       {@link ConnectionState#CONNECTED}，宿主可在状态监听里决定是否补发指令。
 *       注意：桥的会话绑定是连接级状态，重连后原会话事件不会自动续流，需上层重新 attach。</li>
 *   <li><b>多连接</b>：同一 sidecar 可开任意多条 BridgeConnection（各自独立 cmdId 空间、事件流互不串扰；
 *       进程级事件每条连接都会收到）。</li>
 *   <li><b>线程模型</b>：事件/状态监听器在 gRPC 回调线程或内部调度线程上执行，回调内不要做耗时操作，
 *       需要时自行切换线程。</li>
 * </ul>
 */
public final class BridgeConnection implements AutoCloseable {

    /** 默认单条消息上限 64MB：贴图 / 大 diff 场景下 4MB 默认值会超限断连。 */
    public static final int DEFAULT_MAX_INBOUND_MESSAGE_SIZE = 64 * 1024 * 1024;

    private final String host;
    private final CompletionStage<Integer> portStage;
    private final IntFunction<ManagedChannel> channelFactory;
    private final boolean reconnectEnabled;
    private final long reconnectInitialBackoffMillis;
    private final long reconnectMaxBackoffMillis;
    private final int reconnectMaxAttempts; // <=0 表示无限次

    private final ScheduledExecutorService scheduler;
    private final CopyOnWriteArrayList<Consumer<SemaEvent>> eventListeners = new CopyOnWriteArrayList<>();
    private final CopyOnWriteArrayList<ConnectionStateListener> stateListeners = new CopyOnWriteArrayList<>();
    private final ConcurrentLinkedQueue<BridgeCommand> pending = new ConcurrentLinkedQueue<>();

    /** 保护 requests / streamReady / attempts；StreamObserver#onNext 非线程安全，发送也在此锁内。 */
    private final Object sendLock = new Object();
    /** dial 代数：旧流/旧 channel 状态回调凭代数失效，防止重连后旧回调串扰。 */
    private final AtomicInteger generation = new AtomicInteger();

    private volatile ManagedChannel channel;
    private StreamObserver<BridgeCommand> requests; // guarded by sendLock
    private boolean streamReady;                    // guarded by sendLock
    private int attempts;                           // guarded by sendLock
    private volatile ConnectionState state;
    private volatile boolean started;
    private volatile boolean closed;

    private BridgeConnection(Builder b) {
        this.host = b.host;
        this.portStage = Objects.requireNonNull(b.portStage, "port 未设置：Builder#port 或 #portFuture 必须调用其一");
        this.reconnectEnabled = b.reconnectEnabled;
        this.reconnectInitialBackoffMillis = b.reconnectInitialBackoff.toMillis();
        this.reconnectMaxBackoffMillis = b.reconnectMaxBackoff.toMillis();
        this.reconnectMaxAttempts = b.reconnectMaxAttempts;
        int maxInbound = b.maxInboundMessageSize;
        this.channelFactory = b.channelFactory != null ? b.channelFactory
                : port -> OkHttpChannelBuilder.forAddress(host, port)
                        .usePlaintext()
                        .maxInboundMessageSize(maxInbound)
                        .build();
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "sema-bridge-conn");
            t.setDaemon(true);
            return t;
        });
    }

    public static Builder builder() {
        return new Builder();
    }

    // ── 公共 API ──────────────────────────────────────────────────────────

    /** 注册事件监听（收到桥推送的所有帧，含 ack / error）。可在 connect 前后任意时刻调用。 */
    public void onEvent(Consumer<SemaEvent> listener) {
        eventListeners.add(Objects.requireNonNull(listener));
    }

    /** 注册连接状态监听。 */
    public void onStateChange(ConnectionStateListener listener) {
        stateListeners.add(Objects.requireNonNull(listener));
    }

    /** 当前连接状态；connect() 前为 null。 */
    public ConnectionState state() {
        return state;
    }

    /**
     * 启动连接（异步、幂等）。等待端口就绪 → 建 channel → 开双向流；期间的 send 全部入缓冲队列。
     */
    public void connect() {
        if (closed) throw new IllegalStateException("连接已关闭");
        if (started) return;
        started = true;
        setState(ConnectionState.CONNECTING, null);
        portStage.whenComplete((port, err) -> {
            if (err != null) {
                failClose(err);
            } else {
                scheduler.execute(() -> dial(port));
            }
        });
    }

    /**
     * 发送一帧指令（哑转发：payload 为 JSON 字符串，SDK 不解释内容）。
     * 连接未就绪 / 重连中时入缓冲队列，就绪后按序发出。
     *
     * @param id        请求 ID（响应帧以 cmdId 回带）
     * @param action    操作名（与 sema-core 方法名一一对应）
     * @param payload   JSON 序列化的参数，可为 null / 空
     * @param sessionId 目标会话 ID；进程级 action 传空
     */
    public void send(String id, String action, String payload, String sessionId) {
        if (closed) throw new IllegalStateException("连接已关闭");
        BridgeCommand cmd = BridgeCommand.newBuilder()
                .setId(nullToEmpty(id))
                .setAction(nullToEmpty(action))
                .setPayload(nullToEmpty(payload))
                .setSessionId(nullToEmpty(sessionId))
                .build();
        synchronized (sendLock) {
            if (streamReady && requests != null) {
                try {
                    requests.onNext(cmd);
                    return;
                } catch (RuntimeException e) {
                    // 流刚好断开：转入缓冲，等待重连后补发
                }
            }
            pending.add(cmd);
        }
    }

    /** 关闭连接并释放资源；不可再复用。 */
    @Override
    public void close() {
        if (closed) return;
        closed = true;
        generation.incrementAndGet(); // 使一切在途回调失效
        synchronized (sendLock) {
            if (requests != null) {
                try {
                    requests.onCompleted();
                } catch (RuntimeException ignored) {
                }
            }
            requests = null;
            streamReady = false;
        }
        shutdownChannel();
        scheduler.shutdownNow();
        setState(ConnectionState.CLOSED, null);
    }

    // ── 建连 / 重连 ───────────────────────────────────────────────────────

    private void dial(int port) {
        if (closed) return;
        final int gen = generation.incrementAndGet();
        try {
            ManagedChannel ch = channel;
            if (ch == null || ch.isShutdown() || ch.isTerminated()) {
                ch = channelFactory.apply(port);
                channel = ch;
            }
            StreamObserver<BridgeCommand> obs = SemaBridgeGrpc.newStub(ch)
                    .connect(new StreamObserver<>() {
                        @Override
                        public void onNext(BridgeEvent v) {
                            if (closed || generation.get() != gen) return;
                            markConnected(gen); // 收到事件即证明链路活着（兜底 READY 通知的竞态）
                            dispatch(new SemaEvent(v.getEvent(), v.getData(), v.getCmdId(), v.getSessionId()));
                        }

                        @Override
                        public void onError(Throwable t) {
                            streamBroken(gen, t);
                        }

                        @Override
                        public void onCompleted() {
                            streamBroken(gen, null);
                        }
                    });
            synchronized (sendLock) {
                requests = obs;
            }
            awaitReady(ch, gen);
        } catch (RuntimeException e) {
            streamBroken(gen, e);
        }
    }

    /** 等 channel 进入 READY 再宣告 CONNECTED / flush 缓冲，避免把缓冲指令灌进注定失败的流。 */
    private void awaitReady(ManagedChannel ch, int gen) {
        if (closed || generation.get() != gen) return;
        ConnectivityState s = ch.getState(true);
        if (s == ConnectivityState.READY) {
            markConnected(gen);
        } else if (s != ConnectivityState.SHUTDOWN) {
            ch.notifyWhenStateChanged(s, () -> awaitReady(ch, gen));
        }
    }

    private void markConnected(int gen) {
        if (closed || generation.get() != gen) return;
        boolean becameReady = false;
        synchronized (sendLock) {
            if (!streamReady && requests != null) {
                streamReady = true;
                attempts = 0;
                becameReady = true;
            }
        }
        if (becameReady) {
            setState(ConnectionState.CONNECTED, null);
            flushPending();
        }
    }

    private void flushPending() {
        synchronized (sendLock) {
            BridgeCommand cmd;
            while (streamReady && requests != null && (cmd = pending.poll()) != null) {
                try {
                    requests.onNext(cmd);
                } catch (RuntimeException e) {
                    pending.add(cmd); // 回队尾等待下次重连（极端竞态下可能乱序，可接受）
                    return;
                }
            }
        }
    }

    private void streamBroken(int gen, Throwable t) {
        if (closed || generation.get() != gen) return;
        int attempt;
        synchronized (sendLock) {
            requests = null;
            streamReady = false;
            attempt = ++attempts;
        }
        if (!reconnectEnabled || (reconnectMaxAttempts > 0 && attempt > reconnectMaxAttempts)) {
            failClose(t != null ? t : new IllegalStateException("桥主动关闭了连接"));
            return;
        }
        setState(ConnectionState.RECONNECTING, t);
        long backoff = backoffMillis(attempt);
        Integer port = portStage.toCompletableFuture().getNow(null); // 能走到 dial 说明必已完成
        if (port == null) {
            failClose(new IllegalStateException("端口未就绪却发生了流断开"));
            return;
        }
        final int portValue = port;
        try {
            scheduler.schedule(() -> dial(portValue), backoff, TimeUnit.MILLISECONDS);
        } catch (RuntimeException e) {
            // scheduler 已随 close 关闭
        }
    }

    private long backoffMillis(int attempt) {
        long backoff = reconnectInitialBackoffMillis << Math.min(attempt - 1, 20);
        return Math.min(Math.max(backoff, reconnectInitialBackoffMillis), reconnectMaxBackoffMillis);
    }

    private void failClose(Throwable t) {
        if (closed) return;
        closed = true;
        generation.incrementAndGet();
        synchronized (sendLock) {
            requests = null;
            streamReady = false;
        }
        shutdownChannel();
        scheduler.shutdownNow();
        setState(ConnectionState.CLOSED, t);
    }

    private void shutdownChannel() {
        ManagedChannel ch = channel;
        channel = null;
        if (ch == null) return;
        ch.shutdown();
        try {
            ch.awaitTermination(3, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    // ── 分发 ─────────────────────────────────────────────────────────────

    private void dispatch(SemaEvent event) {
        for (Consumer<SemaEvent> l : eventListeners) {
            try {
                l.accept(event);
            } catch (RuntimeException ignored) {
                // 单个监听器异常不影响其他监听器
            }
        }
    }

    private void setState(ConnectionState s, Throwable error) {
        state = s;
        for (ConnectionStateListener l : stateListeners) {
            try {
                l.onStateChange(s, error);
            } catch (RuntimeException ignored) {
            }
        }
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    // ── Builder ──────────────────────────────────────────────────────────

    public static final class Builder {
        private String host = "127.0.0.1";
        private CompletionStage<Integer> portStage;
        private int maxInboundMessageSize = DEFAULT_MAX_INBOUND_MESSAGE_SIZE;
        private boolean reconnectEnabled = true;
        private Duration reconnectInitialBackoff = Duration.ofMillis(250);
        private Duration reconnectMaxBackoff = Duration.ofSeconds(10);
        private int reconnectMaxAttempts = 0;
        private IntFunction<ManagedChannel> channelFactory;

        private Builder() {
        }

        public Builder host(String host) {
            this.host = Objects.requireNonNull(host);
            return this;
        }

        /** 固定端口连接。 */
        public Builder port(int port) {
            this.portStage = CompletableFuture.completedFuture(port);
            return this;
        }

        /** 端口异步就绪（如等待 SidecarManager 启动完成）；connect() 后指令先入缓冲，端口就绪再建连。 */
        public Builder portFuture(CompletionStage<Integer> portStage) {
            this.portStage = Objects.requireNonNull(portStage);
            return this;
        }

        /** 单条入站消息上限，默认 64MB。 */
        public Builder maxInboundMessageSize(int bytes) {
            this.maxInboundMessageSize = bytes;
            return this;
        }

        /** 是否自动重连，默认 true。 */
        public Builder reconnectEnabled(boolean enabled) {
            this.reconnectEnabled = enabled;
            return this;
        }

        /** 重连退避区间，默认 250ms 起、指数翻倍、封顶 10s。 */
        public Builder reconnectBackoff(Duration initial, Duration max) {
            this.reconnectInitialBackoff = Objects.requireNonNull(initial);
            this.reconnectMaxBackoff = Objects.requireNonNull(max);
            return this;
        }

        /** 最大重连次数，&lt;=0 表示无限次（默认）。耗尽后进入 CLOSED。 */
        public Builder reconnectMaxAttempts(int maxAttempts) {
            this.reconnectMaxAttempts = maxAttempts;
            return this;
        }

        /** 自定义 channel 工厂（port → ManagedChannel），替代默认的 okhttp 明文通道。 */
        public Builder channelFactory(IntFunction<ManagedChannel> factory) {
            this.channelFactory = factory;
            return this;
        }

        public BridgeConnection build() {
            return new BridgeConnection(this);
        }
    }
}

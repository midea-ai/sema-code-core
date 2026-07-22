package semacore.protocol;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;
import semacore.transport.BridgeConnection;
import semacore.transport.ConnectionState;
import semacore.transport.SemaEvent;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;

/**
 * sema-grpc 桥的协议层客户端：在 {@link BridgeConnection} 之上提供指令/响应匹配与事件订阅。
 *
 * <ul>
 *   <li>{@link #call}：发指令并返回 CompletableFuture；桥回 ack → 以 data 完成，回 error →
 *       以 {@link SemaBridgeException} 异常完成。payload / data 均为 JSON 字符串（薄客户端不定义类型，
 *       类型化 API 属二期）。</li>
 *   <li>{@link #on} / {@link #once} / {@link #waitFor}：按事件名（可选按 sessionId）订阅桥推送事件。</li>
 *   <li>连接断开（重连中 / 已关闭）时，所有在途 call 立即以异常完成——流断开后桥侧响应已不可达，
 *       上层应在重连成功后自行决定是否重放。</li>
 *   <li>协议逻辑在别处（如 webview JS）的哑转发宿主不需要本类，直接用 {@link BridgeConnection}。</li>
 * </ul>
 */
public final class SemaBridgeClient implements AutoCloseable {

    private static final Gson GSON = new Gson();

    private final BridgeConnection connection;
    private final Map<String, PendingCall> pendingCalls = new ConcurrentHashMap<>();
    private final Map<String, List<Subscription>> subscriptions = new ConcurrentHashMap<>();
    private final CopyOnWriteArrayList<Consumer<SemaEvent>> anyListeners = new CopyOnWriteArrayList<>();

    private record PendingCall(String action, CompletableFuture<String> future) {
    }

    private record Subscription(String sessionFilter, boolean once, EventListener listener) {
    }

    /** 包装一条连接（不代为 connect；宿主自行控制建连时机）。 */
    public SemaBridgeClient(BridgeConnection connection) {
        this.connection = Objects.requireNonNull(connection);
        connection.onEvent(this::dispatch);
        connection.onStateChange((state, error) -> {
            if (state == ConnectionState.RECONNECTING || state == ConnectionState.CLOSED) {
                failPendingCalls(state, error);
            }
        });
    }

    /** 底层连接（注册状态监听、哑转发等场景用）。 */
    public BridgeConnection connection() {
        return connection;
    }

    // ── 指令 ─────────────────────────────────────────────────────────────

    /** 发送进程级指令（session_id 留空）。 */
    public CompletableFuture<String> call(String action, String payloadJson) {
        return call(action, payloadJson, "");
    }

    /**
     * 发送指令并等待响应。
     *
     * @param action      操作名（与 sema-core 方法名一一对应）
     * @param payloadJson JSON 序列化的参数，可为 null
     * @param sessionId   目标会话 ID；进程级 action 传空
     * @return ack 的 data（JSON 字符串，可能为空字符串）。桥回 error / 连接断开时异常完成。
     *         需要超时的调用方自行 {@code future.orTimeout(...)}。
     */
    public CompletableFuture<String> call(String action, String payloadJson, String sessionId) {
        String id = UUID.randomUUID().toString();
        CompletableFuture<String> future = new CompletableFuture<>();
        pendingCalls.put(id, new PendingCall(action, future));
        // 外部 cancel / orTimeout 完成时同步清表，防泄漏
        future.whenComplete((r, e) -> pendingCalls.remove(id));
        try {
            connection.send(id, action, payloadJson, sessionId);
        } catch (RuntimeException e) {
            future.completeExceptionally(e);
        }
        return future;
    }

    // ── 事件订阅 ─────────────────────────────────────────────────────────

    /** 订阅事件（所有会话 + 进程级）。 */
    public Registration on(String event, EventListener listener) {
        return subscribe(event, null, false, listener);
    }

    /** 订阅指定会话的事件（sessionId 精确匹配；进程级事件传 ""）。 */
    public Registration on(String event, String sessionId, EventListener listener) {
        return subscribe(event, Objects.requireNonNull(sessionId), false, listener);
    }

    /** 一次性订阅（触发后自动注销）。 */
    public Registration once(String event, EventListener listener) {
        return subscribe(event, null, true, listener);
    }

    /** 一次性订阅指定会话的事件。 */
    public Registration once(String event, String sessionId, EventListener listener) {
        return subscribe(event, Objects.requireNonNull(sessionId), true, listener);
    }

    /**
     * 等待事件触发一次并返回其 data。
     *
     * @param sessionId 精确匹配的会话 ID；null 表示任意
     * @param timeout   超时时长；null 表示不超时
     */
    public CompletableFuture<String> waitFor(String event, String sessionId, Duration timeout) {
        CompletableFuture<String> future = new CompletableFuture<>();
        Registration reg = subscribe(event, sessionId, true, (data, sid) -> future.complete(data));
        future.whenComplete((r, e) -> reg.unregister()); // 超时/取消时清掉订阅
        if (timeout != null) {
            future.orTimeout(timeout.toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS);
        }
        return future;
    }

    /** 订阅所有推送事件（已排除被 call 消费的 ack/error 响应帧）；调试 / 全量转发用。 */
    public Registration onAny(Consumer<SemaEvent> listener) {
        anyListeners.add(Objects.requireNonNull(listener));
        return () -> anyListeners.remove(listener);
    }

    /** 关闭底层连接。 */
    @Override
    public void close() {
        connection.close();
    }

    // ── 内部 ─────────────────────────────────────────────────────────────

    private Registration subscribe(String event, String sessionFilter, boolean once, EventListener listener) {
        Objects.requireNonNull(event);
        Objects.requireNonNull(listener);
        List<Subscription> list = subscriptions.computeIfAbsent(event, k -> new CopyOnWriteArrayList<>());
        Subscription sub = new Subscription(sessionFilter, once, listener);
        list.add(sub);
        return () -> list.remove(sub);
    }

    private void dispatch(SemaEvent event) {
        // 1) 响应帧：按 cmdId 匹配在途 call；匹配上即消费，不再进入事件分发
        if (event.isResponse()) {
            PendingCall call = pendingCalls.remove(event.cmdId());
            if (call != null) {
                if ("error".equals(event.event())) {
                    call.future().completeExceptionally(toException(call.action(), event.data()));
                } else {
                    call.future().complete(event.data());
                }
                return;
            }
        }

        // 2) 推送事件：全量监听 + 按事件名/会话过滤的订阅
        for (Consumer<SemaEvent> l : anyListeners) {
            try {
                l.accept(event);
            } catch (RuntimeException ignored) {
            }
        }
        List<Subscription> list = subscriptions.get(event.event());
        if (list == null) return;
        for (Subscription sub : list) {
            if (sub.sessionFilter() != null && !sub.sessionFilter().equals(event.sessionId())) continue;
            if (sub.once()) list.remove(sub);
            try {
                sub.listener().onEvent(event.data(), event.sessionId());
            } catch (RuntimeException ignored) {
                // 单个监听器异常不影响其他监听器
            }
        }
    }

    private void failPendingCalls(ConnectionState state, Throwable error) {
        String reason = state == ConnectionState.CLOSED ? "连接已关闭" : "连接断开（重连中），响应已不可达";
        for (String id : pendingCalls.keySet()) {
            PendingCall call = pendingCalls.remove(id);
            if (call != null) {
                call.future().completeExceptionally(new SemaBridgeException(call.action(), reason, error));
            }
        }
    }

    private static SemaBridgeException toException(String action, String dataJson) {
        String message = dataJson;
        try {
            JsonObject obj = GSON.fromJson(dataJson, JsonObject.class);
            if (obj != null && obj.has("message") && !obj.get("message").isJsonNull()) {
                message = obj.get("message").getAsString();
            }
        } catch (JsonSyntaxException ignored) {
            // data 不是 JSON 对象时原样作为 message
        }
        return new SemaBridgeException(action, message == null || message.isEmpty() ? "Unknown error" : message);
    }
}

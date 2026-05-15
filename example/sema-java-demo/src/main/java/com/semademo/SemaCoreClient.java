package com.semademo;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import okhttp3.*;

import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;

/**
 * sema-core Java 客户端
 * 通过 WebSocket 连接桥接服务，提供与 sema-core 的全双工通信能力
 */
public class SemaCoreClient implements AutoCloseable {

    private final OkHttpClient http = new OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();

    private WebSocket ws;
    private final ObjectMapper mapper = new ObjectMapper();

    // 等待 ack 的 Future：cmdId -> Future
    private final ConcurrentHashMap<String, CompletableFuture<BridgeEvent>> pending = new ConcurrentHashMap<>();

    // 事件处理器注册表：eventName -> handlers
    private final ConcurrentHashMap<String, CopyOnWriteArrayList<Consumer<JsonNode>>> handlers = new ConcurrentHashMap<>();

    // ── 事件订阅 ──────────────────────────────────────────────────

    /** 注册事件处理器 */
    public void on(String event, Consumer<JsonNode> handler) {
        handlers.computeIfAbsent(event, k -> new CopyOnWriteArrayList<>()).add(handler);
    }

    /** 注册一次性事件处理器（触发后自动注销） */
    public void once(String event, Consumer<JsonNode> handler) {
        // 用 AtomicReference 存自身引用，以便在 lambda 内移除
        AtomicReference<Consumer<JsonNode>> ref = new AtomicReference<>();
        Consumer<JsonNode> wrapper = data -> {
            handler.accept(data);
            CopyOnWriteArrayList<Consumer<JsonNode>> list = handlers.get(event);
            if (list != null) list.remove(ref.get());
        };
        ref.set(wrapper);
        handlers.computeIfAbsent(event, k -> new CopyOnWriteArrayList<>()).add(wrapper);
    }

    // ── 连接 ──────────────────────────────────────────────────────

    /** 连接到 sema-bridge 桥接服务 */
    public CompletableFuture<Void> connectAsync(String url) {
        CompletableFuture<Void> ready = new CompletableFuture<>();
        Request req = new Request.Builder().url(url).build();
        ws = http.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket s, Response r) {
                ready.complete(null);
            }

            @Override
            public void onMessage(WebSocket s, String text) {
                dispatch(text);
            }

            @Override
            public void onFailure(WebSocket s, Throwable t, Response r) {
                if (!ready.isDone()) ready.completeExceptionally(t);
                pending.values().forEach(f -> f.completeExceptionally(t));
                pending.clear();
            }
        });
        return ready;
    }

    // ── 接收分发 ──────────────────────────────────────────────────

    private void dispatch(String text) {
        try {
            BridgeEvent evt = mapper.readValue(text, BridgeEvent.class);
            if (evt == null) return;

            // 处理指令响应（ack / error with cmdId）
            if (evt.cmdId != null) {
                CompletableFuture<BridgeEvent> f = pending.remove(evt.cmdId);
                if (f != null) {
                    if ("error".equals(evt.event)) {
                        String msg = evt.data != null && evt.data.has("message")
                                ? evt.data.get("message").asText() : "Unknown error";
                        f.completeExceptionally(new RuntimeException(msg));
                    } else {
                        f.complete(evt);
                    }
                }
            }

            // 分发推送事件给订阅的处理器
            CopyOnWriteArrayList<Consumer<JsonNode>> list = handlers.get(evt.event);
            if (list != null)
                for (Consumer<JsonNode> h : list) h.accept(evt.data);

        } catch (Exception e) {
            System.err.println("[SemaCoreClient] Receive error: " + e.getMessage());
        }
    }

    // ── 发送指令 ──────────────────────────────────────────────────

    /** 发送指令并等待响应（ack 或 error） */
    public CompletableFuture<BridgeEvent> sendCommandAsync(String action, Object payload, int timeoutMs) {
        try {
            BridgeCommand cmd = new BridgeCommand(action, payload);
            CompletableFuture<BridgeEvent> future = new CompletableFuture<>();
            pending.put(cmd.id, future);
            ws.send(mapper.writeValueAsString(cmd));
            return future.orTimeout(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            return CompletableFuture.failedFuture(e);
        }
    }

    public CompletableFuture<BridgeEvent> sendCommandAsync(String action, Object payload) {
        return sendCommandAsync(action, payload, 15_000);
    }

    public CompletableFuture<BridgeEvent> sendCommandAsync(String action) {
        return sendCommandAsync(action, null, 15_000);
    }

    // ── 高级封装 API ──────────────────────────────────────────────

    /** 创建或恢复会话 */
    public CompletableFuture<BridgeEvent> createSessionAsync(String sessionId) {
        return sendCommandAsync("session.create", sessionId != null ? Map.of("sessionId", sessionId) : null);
    }

    public CompletableFuture<BridgeEvent> createSessionAsync() {
        return createSessionAsync(null);
    }

    /** 发送用户消息 */
    public CompletableFuture<BridgeEvent> sendUserInputAsync(String content) {
        return sendCommandAsync("session.input", Map.of("content", content));
    }

    /** 中断当前处理 */
    public CompletableFuture<BridgeEvent> interruptAsync() {
        return sendCommandAsync("session.interrupt");
    }

    /** 响应工具权限请求 */
    public CompletableFuture<BridgeEvent> respondToPermissionAsync(String toolId, String toolName, String selected) {
        return sendCommandAsync("permission.respond", Map.of("toolId", toolId, "toolName", toolName, "selected", selected));
    }

    /** 响应问答请求 */
    public CompletableFuture<BridgeEvent> respondToQuestionAsync(String agentId, Map<String, String> answers) {
        return sendCommandAsync("question.respond", Map.of("agentId", agentId, "answers", answers));
    }

    /** 响应计划退出请求 */
    public CompletableFuture<BridgeEvent> respondToPlanExitAsync(String agentId, String selected) {
        return sendCommandAsync("plan.respond", Map.of("agentId", agentId, "selected", selected));
    }

    /** 添加模型 */
    public CompletableFuture<BridgeEvent> addModelAsync(Object config, boolean skipValidation) {
        return sendCommandAsync("model.add", Map.of("config", config, "skipValidation", skipValidation));
    }

    /** 应用任务模型配置（main / quick 使用的模型 ID） */
    public CompletableFuture<BridgeEvent> applyTaskModelAsync(String main, String quick) {
        return sendCommandAsync("model.applyTask", Map.of("main", main, "quick", quick));
    }

    /** 删除模型 */
    public CompletableFuture<BridgeEvent> delModelAsync(String modelName) {
        return sendCommandAsync("model.del", Map.of("modelName", modelName));
    }

    /** 切换模型 */
    public CompletableFuture<BridgeEvent> switchModelAsync(String modelName) {
        return sendCommandAsync("model.switch", Map.of("modelName", modelName));
    }

    /** 获取模型信息 */
    public CompletableFuture<BridgeEvent> getModelDataAsync() {
        return sendCommandAsync("model.getData");
    }

    /** 设置代理模式（Agent / Plan） */
    public CompletableFuture<BridgeEvent> setAgentModeAsync(String mode) {
        return sendCommandAsync("config.updateAgentMode", Map.of("mode", mode));
    }

    /**
     * 初始化核心配置（在 createSession 之前调用）。
     * 会以新配置重建底层 SemaCore 实例，workingDir 等构造函数级别的选项在此生效。
     */
    public CompletableFuture<BridgeEvent> initCoreAsync(SemaCoreConfig config) {
        return sendCommandAsync("config.init", config);
    }

    /** 更新运行时配置（会话创建后也可调用） */
    public CompletableFuture<BridgeEvent> updateConfigAsync(Object config) {
        return sendCommandAsync("config.update", config);
    }

    /** 销毁会话 */
    public CompletableFuture<BridgeEvent> disposeSessionAsync() {
        return sendCommandAsync("session.dispose");
    }

    // ── 释放 ──────────────────────────────────────────────────────

    @Override
    public void close() {
        if (ws != null) ws.close(1000, "bye");
        http.dispatcher().executorService().shutdown();
    }
}

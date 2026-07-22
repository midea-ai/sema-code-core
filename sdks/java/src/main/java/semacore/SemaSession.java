package semacore;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.reflect.TypeToken;
import semacore.protocol.Registration;
import semacore.protocol.SemaBridgeClient;
import semacore.type.*;
import semacore.event.ToolPermissionResponse;
import semacore.event.PickOptionResponseData;
import semacore.event.PlanExitResponseData;

import java.lang.reflect.Type;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Predicate;

/**
 * sema-core 会话的镜像 API：用法与 Node 侧 {@code const session = await core.createSession()} 一致。
 *
 * <p>方法名/参数名 = core 的 SemaSession；返回值 = core 返回类型（{@code semacore.type} 强类型 DTO）；
 * 事件名 = core 原始事件名，{@link #on} 自动按本会话 sessionId 过滤，回调 data 为 {@link JsonElement}。
 * 同步/阻塞语义与死锁注意事项见 {@link SemaCore}。</p>
 *
 * <p><b>创建期事件语义</b>：会话对象构造时即捕获 {@code session:ready} 并缓存，之后（含晚）订阅立即重放，
 * 保证 Node 式「createSession 后再订阅」不丢事件。</p>
 */
public final class SemaSession {

    private static final Gson GSON = new Gson();
    private static final Type LIST_STRING = new TypeToken<List<String>>() {}.getType();

    private final SemaBridgeClient client;
    private final String sessionId;
    private final CompletableFuture<JsonElement> ready = new CompletableFuture<>();
    private final List<Sub> subs = new ArrayList<>();

    private record Sub(String event, Consumer<JsonElement> handler, Registration reg) {}

    SemaSession(SemaBridgeClient client, String sessionId) {
        this.client = client;
        this.sessionId = sessionId;
        // 构造发生在 createSession ack 的分发链上，早于桥推送 session:ready（同一 gRPC 流串行分发），故此处订阅必不丢失。
        client.once("session:ready", sessionId, (data, sid) -> ready.complete(Json.parse(data)));
    }

    public String sessionId() {
        return sessionId;
    }

    // ── 会话交互 ─────────────────────────────────────────────────────────

    public void processUserInput(String input) {
        processUserInput(input, null, null);
    }

    public void processUserInput(String input, String originalInput) {
        processUserInput(input, originalInput, null);
    }

    public void processUserInput(String input, String originalInput, List<InputImageAttachment> attachments) {
        send("processUserInput", Json.obj("content", input, "orgContent", originalInput, "attachments", attachments));
    }

    public void interrupt() {
        send("interrupt", null);
    }

    // ── 交互应答 ─────────────────────────────────────────────────────────

    public void respondToToolPermission(ToolPermissionResponse response) {
        send("respondToToolPermission", response);
    }

    public void respondToPickOption(PickOptionResponseData response) {
        send("respondToPickOption", response);
    }

    public void respondToPlanExit(PlanExitResponseData response) {
        send("respondToPlanExit", response);
    }

    // ── 模式 / 权限 ──────────────────────────────────────────────────────

    public void updateAgentMode(AgentMode mode) {
        send("updateAgentMode", Json.obj("mode", mode));
    }

    public void updatePermissionLevel(PermissionLevel level) {
        send("updatePermissionLevel", Json.obj("level", level));
    }

    // ── fork / 撤销回退 ──────────────────────────────────────────────────

    public ForkPreview getForkPreview(String messageUuid) {
        return call("getForkPreview", Json.obj("messageUuid", messageUuid), ForkPreview.class);
    }

    public ForkResult fork(String messageUuid) {
        return fork(messageUuid, null);
    }

    public ForkResult fork(String messageUuid, ForkOptions options) {
        JsonElement el = req("fork", Json.obj("messageUuid", messageUuid, "options", options));
        // 判别联合按 ok 分派到具体变体（≙ core ForkResult）
        return SemaJson.bool(el, "ok", false)
                ? GSON.fromJson(el, ForkResultOk.class)
                : GSON.fromJson(el, ForkResultErr.class);
    }

    // ── 后台任务（会话级）────────────────────────────────────────────────

    public List<TaskListItem> getTaskList() {
        return callList("getTaskList", null, TaskListItem.class);
    }

    /** 停掉本会话全部后台子 agent；返回停掉数量。 */
    public int stopAllTasks() {
        return SemaJson.i32(req("stopAllTasks", null), "count", 0);
    }

    public boolean stopTask(String taskId) {
        return SemaJson.bool(req("stopTask", Json.obj("taskId", taskId)), "ok", false);
    }

    public boolean transferAgentToBackground(String taskId) {
        return SemaJson.bool(req("transferAgentToBackground", Json.obj("taskId", taskId)), "ok", false);
    }

    public List<String> transferAllForegroundAgents() {
        return GSON.fromJson(SemaJson.get(req("transferAllForegroundAgents", null), "taskIds"), LIST_STRING);
    }

    /** 开始流式观察任务输出；关闭返回的 Registration 会停止观察并退订事件。 */
    public Registration watchTask(String taskId, Consumer<String> onDelta) {
        Objects.requireNonNull(taskId);
        Objects.requireNonNull(onDelta);
        AtomicBoolean active = new AtomicBoolean(true);
        Registration registration = client.on("task:watch:delta", sessionId, (data, sid) -> {
            JsonElement element = Json.parse(data);
            if (!element.isJsonObject()) return;
            JsonElement eventTaskId = element.getAsJsonObject().get("taskId");
            if (eventTaskId == null || !taskId.equals(eventTaskId.getAsString())) return;
            JsonElement delta = element.getAsJsonObject().get("delta");
            if (delta != null && !delta.isJsonNull()) onDelta.accept(delta.getAsString());
        });
        send("watchTask", Json.obj("taskId", taskId));
        return () -> {
            if (!active.compareAndSet(true, false)) return;
            registration.unregister();
            send("unwatchTask", Json.obj("taskId", taskId));
        };
    }

    // ── 事件（core 原始事件名，自动按本会话过滤）─────────────────────────

    public Registration on(String event, Consumer<JsonElement> handler) {
        if ("session:ready".equals(event)) return subscribeReady(handler);
        Registration reg = client.on(event, sessionId, (data, sid) -> handler.accept(Json.parse(data)));
        subs.add(new Sub(event, handler, reg));
        return reg;
    }

    public Registration once(String event, Consumer<JsonElement> handler) {
        if ("session:ready".equals(event)) return subscribeReady(handler);
        Registration reg = client.once(event, sessionId, (data, sid) -> handler.accept(Json.parse(data)));
        subs.add(new Sub(event, handler, reg));
        return reg;
    }

    /** 按 (event, handler) 取消订阅（≙ Node off）；移除首个匹配的 on/once 注册。 */
    public void off(String event, Consumer<JsonElement> handler) {
        for (int i = 0; i < subs.size(); i++) {
            Sub s = subs.get(i);
            if (s.event().equals(event) && s.handler() == handler) {
                s.reg().unregister();
                subs.remove(i);
                return;
            }
        }
    }

    /** 等待本会话某事件触发一次；timeout 为 null 表示不超时。 */
    public JsonElement waitFor(String event, Duration timeout) {
        return waitFor(event, timeout, null);
    }

    /** 等待本会话某事件（可选 predicate 对解析后的 data 过滤）。 */
    public JsonElement waitFor(String event, Duration timeout, Predicate<JsonElement> predicate) {
        if ("session:ready".equals(event)) {
            JsonElement cached = ready.getNow(null);
            if (cached != null && (predicate == null || predicate.test(cached))) return cached;
        }
        CompletableFuture<JsonElement> future = new CompletableFuture<>();
        Registration reg = client.on(event, sessionId, (data, sid) -> {
            JsonElement d = Json.parse(data);
            if (predicate == null || predicate.test(d)) future.complete(d);
        });
        future.whenComplete((r, e) -> reg.unregister());
        if (timeout != null) future.orTimeout(timeout.toMillis(), TimeUnit.MILLISECONDS);
        try {
            return future.join();
        } catch (CompletionException e) {
            Throwable c = e.getCause();
            if (c instanceof RuntimeException re) throw re;
            throw e;
        }
    }

    /** session:ready 走缓存重放（本质一次性事件，on/once 等价）。 */
    private Registration subscribeReady(Consumer<JsonElement> handler) {
        AtomicBoolean active = new AtomicBoolean(true);
        ready.thenAccept(data -> {
            if (active.get()) handler.accept(data);
        });
        return () -> active.set(false);
    }

    // ── 生命周期 ─────────────────────────────────────────────────────────

    /** 关闭本会话（≙ core.closeSession；只关会话不关连接）。 */
    public boolean close() {
        JsonElement ack = Json.parse(SemaCore.join(client.call("closeSession", null, sessionId)));
        return SemaJson.bool(ack, "ok", false);
    }

    // ── 内部 ─────────────────────────────────────────────────────────────

    private JsonElement req(String action, Object payload) {
        return Json.parse(SemaCore.join(client.call(action, Json.stringify(payload), sessionId)));
    }

    private <T> T call(String action, Object payload, Class<T> type) {
        return GSON.fromJson(req(action, payload), type);
    }

    private <T> List<T> callList(String action, Object payload, Class<T> elem) {
        Type t = TypeToken.getParameterized(List.class, elem).getType();
        List<T> list = GSON.fromJson(req(action, payload), t);
        return list != null ? list : new ArrayList<>();
    }

    /** fire-and-forget（Node void 语义）：发送不阻塞，不等 ack。 */
    private void send(String action, Object payload) {
        client.call(action, Json.stringify(payload), sessionId).exceptionally(e -> null);
    }
}

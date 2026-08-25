package semacore;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.reflect.TypeToken;
import semacore.protocol.Registration;
import semacore.protocol.SemaBridgeClient;
import semacore.protocol.SemaBridgeException;
import semacore.runtime.SidecarManager;
import semacore.transport.BridgeConnection;
import semacore.type.*;

import java.lang.reflect.Type;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.function.Consumer;

/**
 * sema-core 的进程级镜像 API：用法与 Node 侧 {@code new SemaCore(config)} 一致。
 *
 * <p><b>镜像原则</b>：方法名 = core 方法名、参数名 = core 参数名、事件名 = core 原始事件名，
 * 返回值 = core 返回类型（{@code semacore.type} 下的强类型 DTO，字段名与 core 完全一致）。
 * 入参用 typed DTO（可选字段多的用 {@code Builder}）；事件数据在回调里为 {@link JsonElement}，
 * 需要类型化时用对应 {@code semacore.event} DTO 自行反序列化。</p>
 *
 * <p><b>同步形态</b>：Node 侧 {@code await} 的方法在此为「内部阻塞、直接返回值」（不暴露
 * {@code CompletableFuture}，语义 = Python 的 {@code await} 行）；Node 侧 {@code void} 的方法
 * （{@code processUserInput} 等）仍为 fire-and-forget {@code void}。
 * ⚠️ 会阻塞的方法不要在事件回调线程里调用（ack 与事件同线程串行分发，会死锁）。</p>
 *
 * <pre>{@code
 * SemaCore core = SemaCore.start(SemaCoreConfig.builder().workingDir(dir).thinking(true).build());
 * SemaSession session = core.createSession();
 * session.on("message:text:chunk", data -> System.out.print(data.getAsJsonObject().get("delta").getAsString()));
 * session.processUserInput("你好");
 * ModelUpdateData model = core.getModelData();
 * core.close();
 * }</pre>
 */
public final class SemaCore implements AutoCloseable {

    /** 桥协议版本；{@code init} ack 携带 {@code protocolVersion}，不等即快速失败（防 SDK 与 sidecar 产物漂移）。 */
    private static final int PROTOCOL_VERSION = 1;
    private static final Gson GSON = new Gson();
    private static final Type LIST_STRING = new TypeToken<List<String>>() {}.getType();

    private final SemaBridgeClient client;
    /** start() 托管的 sidecar；attach 到外部连接时为 null（close 不越权关别人的桥） */
    private final AutoCloseable ownedSidecar;
    /** 本 Core 注册的进程级监听器，支持 off(event, listener) */
    private final List<Sub> subs = new ArrayList<>();

    private record Sub(String event, Consumer<JsonElement> handler, Registration reg) {}

    private SemaCore(SemaBridgeClient client, AutoCloseable ownedSidecar) {
        this.client = client;
        this.ownedSidecar = ownedSidecar;
    }

    // ── 获取实例（≙ Node: new SemaCore(config)，经桥 init，非破坏式）──────────

    /** 一步式入口（无参，工作目录取当前目录）。 */
    public static SemaCore start() {
        return start(null);
    }

    /**
     * 一步式入口：拉起托管 sidecar（node/rg 自动供应、按需下载）→ 建连 → init → 版本握手。
     * {@code workingDir} 从 config 读取（与 Node 一致），缺省当前目录。阻塞直到就绪；
     * {@link #close()} 级联关闭 sidecar。需要多连接 / 自定义 NodeProvider 时用 {@link #attach}。
     */
    public static SemaCore start(SemaCoreConfig config) {
        SidecarManager.Builder builder = SidecarManager.builder();
        if (config != null && config.workingDir() != null) builder.workingDir(Path.of(config.workingDir()));
        SidecarManager sidecar = builder.build();
        try {
            return attach(sidecar.newClient(), config, sidecar);
        } catch (RuntimeException e) {
            sidecar.close();
            throw e;
        }
    }

    /** 经指定协议层客户端初始化 core；init ack 后返回（含协议版本握手）。 */
    public static SemaCore attach(SemaBridgeClient client, SemaCoreConfig config) {
        return attach(client, config, null);
    }

    /** 经指定连接初始化 core（未 connect 会自动 connect）。 */
    public static SemaCore attach(BridgeConnection connection, SemaCoreConfig config) {
        connection.connect();
        return attach(new SemaBridgeClient(connection), config);
    }

    private static SemaCore attach(SemaBridgeClient client, SemaCoreConfig config, AutoCloseable ownedSidecar) {
        Objects.requireNonNull(client);
        JsonElement ack = Json.parse(join(client.call("init", Json.stringify(config))));
        int bridgeVersion = SemaJson.i32(ack, "protocolVersion", -1);
        if (bridgeVersion != PROTOCOL_VERSION) {
            throw new SemaBridgeException("init",
                    "桥协议版本不匹配：SDK 需要 " + PROTOCOL_VERSION + "，sidecar 上报 "
                            + (bridgeVersion == -1 ? "无（产物过旧）" : bridgeVersion)
                            + "。请重新构建 sdks/shared/bridge（npm run build）并重装 SDK，保持二者同版本。");
        }
        return new SemaCore(client, ownedSidecar);
    }

    /** 底层协议层客户端（哑转发 / 调试等场景的逃生口）。 */
    public SemaBridgeClient client() {
        return client;
    }

    // ── 核心配置 ─────────────────────────────────────────────────────────

    public void updateCoreConfig(UpdatableCoreConfig config) {
        send("updateCoreConfig", config);
    }

    public void updateCoreConfByKey(UpdatableCoreConfigKeys key, Object value) {
        send("updateCoreConfByKey", Json.obj("key", key, "value", value));
    }

    // 更新全局禁用工具（黑名单）；toolNames 传 null 清空（须显式发 null，故手工拼 payload）
    public void updateDisabledTools(List<String> toolNames) {
        String payload = toolNames == null
                ? "{\"disabledTools\":null}"
                : Json.stringify(Json.obj("disabledTools", toolNames));
        client.call("updateDisabledTools", payload).exceptionally(e -> null);
    }

    // ── 历史清理 ─────────────────────────────────────────────────────────

    /** 删除单个会话的 core 落盘历史文件（宿主删除历史条目后同步清理）。 */
    public void deleteSessionHistory(String sessionId) {
        deleteSessionHistory(sessionId, null);
    }

    /** projectPath 缺省为当前工作目录对应项目。 */
    public void deleteSessionHistory(String sessionId, String projectPath) {
        send("deleteSessionHistory", Json.obj("sessionId", sessionId, "projectPath", projectPath));
    }

    /** 删除指定项目的全部历史与快照目录。 */
    public void deleteProjectHistory(String projectPath) {
        send("deleteProjectHistory", Json.obj("projectPath", projectPath));
    }

    // ── 模型管理 ─────────────────────────────────────────────────────────

    public ModelUpdateData addModel(ModelConfig config) {
        return addModel(config, null);
    }

    public ModelUpdateData addModel(ModelConfig config, Boolean skipValidation) {
        return call("addModel", Json.obj("config", config, "skipValidation", skipValidation), ModelUpdateData.class);
    }

    public ModelUpdateData delModel(String modelName) {
        return call("delModel", Json.obj("modelName", modelName), ModelUpdateData.class);
    }

    public ModelUpdateData switchModel(String modelName) {
        return call("switchModel", Json.obj("modelName", modelName), ModelUpdateData.class);
    }

    public ModelUpdateData applyTaskModel(TaskConfig config) {
        return call("applyTaskModel", config, ModelUpdateData.class);
    }

    public ModelUpdateData getModelData() {
        return call("getModelData", null, ModelUpdateData.class);
    }

    public FetchModelsResult fetchAvailableModels(FetchModelsParams params) {
        return call("fetchAvailableModels", params, FetchModelsResult.class);
    }

    public ApiTestResult testApiConnection(ApiTestParams params) {
        return call("testApiConnection", params, ApiTestResult.class);
    }

    public AdapterType getModelAdapter(String provider, String modelName, String baseURL) {
        return call("getModelAdapter", Json.obj("provider", provider, "modelName", modelName, "baseURL", baseURL), AdapterType.class);
    }

    // ── 会话 ─────────────────────────────────────────────────────────────

    public List<String> listSessions() {
        return GSON.fromJson(SemaJson.get(req("listSessions", null), "sessions"), LIST_STRING);
    }

    public boolean setActiveSession(String sessionId) {
        return boolAck("setActiveSession", Json.obj("sessionId", sessionId));
    }

    public SemaSession createSession() {
        return createSession(null);
    }

    public SemaSession createSession(CreateSessionOptions opts) {
        JsonElement data = req("createSession", opts);
        return new SemaSession(client, SemaJson.str(data, "sessionId"));
    }

    /** 已存在会话的本地句柄（不发指令；用于按 listSessions 结果重新拿到会话对象）。 */
    public SemaSession session(String sessionId) {
        return new SemaSession(client, Objects.requireNonNull(sessionId));
    }

    /** {@link #session(String)} 的 core 同名别名。 */
    public SemaSession getSession(String sessionId) {
        return session(sessionId);
    }

    public boolean closeSession(String sessionId) {
        JsonElement ack = Json.parse(join(client.call("closeSession", null, Objects.requireNonNull(sessionId))));
        return SemaJson.bool(ack, "ok", false);
    }

    // ── 工具 ─────────────────────────────────────────────────────────────

    public List<ToolInfo> getToolInfos() {
        return callList("getToolInfos", null, ToolInfo.class);
    }

    // ── 插件市场 ─────────────────────────────────────────────────────────

    public MarketplacePluginsInfo getMarketplacePluginsInfo() {
        return call("getMarketplacePluginsInfo", null, MarketplacePluginsInfo.class);
    }

    public MarketplacePluginsInfo refreshMarketplacePluginsInfo() {
        return call("refreshMarketplacePluginsInfo", null, MarketplacePluginsInfo.class);
    }

    public MarketplacePluginsInfo addMarketplaceFromGit(String repo) {
        return call("addMarketplaceFromGit", Json.obj("repo", repo), MarketplacePluginsInfo.class);
    }

    public MarketplacePluginsInfo addMarketplaceFromDirectory(String dirPath) {
        return call("addMarketplaceFromDirectory", Json.obj("dirPath", dirPath), MarketplacePluginsInfo.class);
    }

    public MarketplacePluginsInfo updateMarketplace(String marketplaceName) {
        return call("updateMarketplace", Json.obj("marketplaceName", marketplaceName), MarketplacePluginsInfo.class);
    }

    public MarketplacePluginsInfo removeMarketplace(String marketplaceName) {
        return call("removeMarketplace", Json.obj("marketplaceName", marketplaceName), MarketplacePluginsInfo.class);
    }

    public MarketplacePluginsInfo installPlugin(String pluginName, String marketplaceName, PluginScopeKind scope) {
        return installPlugin(pluginName, marketplaceName, scope, null);
    }

    public MarketplacePluginsInfo installPlugin(String pluginName, String marketplaceName, PluginScopeKind scope, String projectPath) {
        return plugin("installPlugin", pluginName, marketplaceName, scope, projectPath);
    }

    public MarketplacePluginsInfo uninstallPlugin(String pluginName, String marketplaceName, PluginScopeKind scope) {
        return uninstallPlugin(pluginName, marketplaceName, scope, null);
    }

    public MarketplacePluginsInfo uninstallPlugin(String pluginName, String marketplaceName, PluginScopeKind scope, String projectPath) {
        return plugin("uninstallPlugin", pluginName, marketplaceName, scope, projectPath);
    }

    public MarketplacePluginsInfo enablePlugin(String pluginName, String marketplaceName, PluginScopeKind scope) {
        return enablePlugin(pluginName, marketplaceName, scope, null);
    }

    public MarketplacePluginsInfo enablePlugin(String pluginName, String marketplaceName, PluginScopeKind scope, String projectPath) {
        return plugin("enablePlugin", pluginName, marketplaceName, scope, projectPath);
    }

    public MarketplacePluginsInfo disablePlugin(String pluginName, String marketplaceName, PluginScopeKind scope) {
        return disablePlugin(pluginName, marketplaceName, scope, null);
    }

    public MarketplacePluginsInfo disablePlugin(String pluginName, String marketplaceName, PluginScopeKind scope, String projectPath) {
        return plugin("disablePlugin", pluginName, marketplaceName, scope, projectPath);
    }

    public MarketplacePluginsInfo updatePlugin(String pluginName, String marketplaceName, PluginScopeKind scope) {
        return updatePlugin(pluginName, marketplaceName, scope, null);
    }

    public MarketplacePluginsInfo updatePlugin(String pluginName, String marketplaceName, PluginScopeKind scope, String projectPath) {
        return plugin("updatePlugin", pluginName, marketplaceName, scope, projectPath);
    }

    // ── Agents / Skills / Commands ───────────────────────────────────────

    public List<AgentConfig> getAgentsInfo() {
        return getAgentsInfo(null, null);
    }

    public List<AgentConfig> getAgentsInfo(Boolean concise, Boolean refresh) {
        return callList("getAgentsInfo", Json.obj("concise", concise, "refresh", refresh), AgentConfig.class);
    }

    public List<AgentConfig> addAgentConf(AgentConfig agentConf) {
        return callList("addAgentConf", agentConf, AgentConfig.class);
    }

    public List<AgentConfig> removeAgentConf(String name) {
        return callList("removeAgentConf", Json.obj("name", name), AgentConfig.class);
    }

    public List<SkillConfig> getSkillsInfo() {
        return getSkillsInfo(null, null);
    }

    public List<SkillConfig> getSkillsInfo(Boolean concise, Boolean refresh) {
        return callList("getSkillsInfo", Json.obj("concise", concise, "refresh", refresh), SkillConfig.class);
    }

    public List<SkillConfig> removeSkillConf(String name) {
        return callList("removeSkillConf", Json.obj("name", name), SkillConfig.class);
    }

    public List<CommandConfig> getCommandsInfo() {
        return getCommandsInfo(null, null);
    }

    public List<CommandConfig> getCommandsInfo(Boolean concise, Boolean refresh) {
        return callList("getCommandsInfo", Json.obj("concise", concise, "refresh", refresh), CommandConfig.class);
    }

    public List<CommandConfig> addCommandConf(CommandConfig commandConf) {
        return callList("addCommandConf", commandConf, CommandConfig.class);
    }

    public List<CommandConfig> removeCommandConf(String name) {
        return callList("removeCommandConf", Json.obj("name", name), CommandConfig.class);
    }

    // ── MCP ──────────────────────────────────────────────────────────────

    public List<MCPServerInfo> getMCPServerInfo() {
        return callList("getMCPServerInfo", null, MCPServerInfo.class);
    }

    public List<MCPServerInfo> refreshMCPServerInfo() {
        return callList("refreshMCPServerInfo", null, MCPServerInfo.class);
    }

    public List<MCPServerInfo> addMCPServer(MCPServerConfig mcpConfig) {
        return callList("addMCPServer", mcpConfig, MCPServerInfo.class);
    }

    public List<MCPServerInfo> removeMCPServer(String name) {
        return callList("removeMCPServer", Json.obj("name", name), MCPServerInfo.class);
    }

    public List<MCPServerInfo> reconnectMCPServer(String name) {
        return callList("reconnectMCPServer", Json.obj("name", name), MCPServerInfo.class);
    }

    public List<MCPServerInfo> disableMCPServer(String name) {
        return callList("disableMCPServer", Json.obj("name", name), MCPServerInfo.class);
    }

    public List<MCPServerInfo> enableMCPServer(String name) {
        return callList("enableMCPServer", Json.obj("name", name), MCPServerInfo.class);
    }

    public List<MCPServerInfo> updateMCPUseTools(String name, List<String> toolNames) {
        return callList("updateMCPUseTools", Json.obj("name", name, "toolNames", toolNames), MCPServerInfo.class);
    }

    // ── Cron ─────────────────────────────────────────────────────────────

    public List<CronTask> getCronTasks() {
        return callList("getCronTasks", null, CronTask.class);
    }

    public boolean deleteCronTask(String id) {
        return boolAck("deleteCronTask", Json.obj("id", id));
    }

    public boolean enableCronTask(String id) {
        return boolAck("enableCronTask", Json.obj("id", id));
    }

    public boolean disableCronTask(String id) {
        return boolAck("disableCronTask", Json.obj("id", id));
    }

    // ── Memory / Rules / Design ──────────────────────────────────────────

    public MemoryConfig getMemoryInfo() {
        return getMemoryInfo(null);
    }

    public MemoryConfig getMemoryInfo(Boolean refresh) {
        return call("getMemoryInfo", Json.obj("refresh", refresh), MemoryConfig.class);
    }

    public RuleConfig getRuleInfo() {
        return getRuleInfo(null);
    }

    public RuleConfig getRuleInfo(Boolean refresh) {
        return call("getRuleInfo", Json.obj("refresh", refresh), RuleConfig.class);
    }

    public HooksInfo getHooksInfo() {
        return getHooksInfo(null);
    }

    public HooksInfo getHooksInfo(Boolean refresh) {
        return call("getHooksInfo", Json.obj("refresh", refresh), HooksInfo.class);
    }

    public List<DesignSkillInfo> getDesignSkillsInfo() {
        return getDesignSkillsInfo(null);
    }

    public List<DesignSkillInfo> getDesignSkillsInfo(Boolean refresh) {
        return callList("getDesignSkillsInfo", Json.obj("refresh", refresh), DesignSkillInfo.class);
    }

    public List<DesignSystemInfo> getDesignSystemsInfo() {
        return getDesignSystemsInfo(null);
    }

    public List<DesignSystemInfo> getDesignSystemsInfo(Boolean refresh) {
        return callList("getDesignSystemsInfo", Json.obj("refresh", refresh), DesignSystemInfo.class);
    }

    // ── 进程级事件（cron:update / mcp:server:status 等；不绑定 sessionId）──

    /** 订阅进程级事件（事件名为 core 原始名）；data 为 JSON 级事件数据，需要类型化用 semacore.event DTO 反序列化。 */
    public Registration on(String event, Consumer<JsonElement> handler) {
        Registration reg = client.on(event, "", (data, sid) -> handler.accept(Json.parse(data)));
        subs.add(new Sub(event, handler, reg));
        return reg;
    }

    public Registration once(String event, Consumer<JsonElement> handler) {
        Registration reg = client.once(event, "", (data, sid) -> handler.accept(Json.parse(data)));
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

    /**
     * ≙ Node 的 {@code core.dispose()}：关闭底层连接；{@link #start} 创建的实例级联停掉托管 sidecar。
     */
    @Override
    public void close() {
        client.close();
        if (ownedSidecar != null) {
            try {
                ownedSidecar.close();
            } catch (Exception ignored) {
                // 退出路径尽力而为
            }
        }
    }

    // ── 内部 ─────────────────────────────────────────────────────────────

    /** 阻塞请求，返回原始 JsonElement（空 ack 为 JsonNull）。 */
    private JsonElement req(String action, Object payload) {
        return Json.parse(join(client.call(action, Json.stringify(payload))));
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
        client.call(action, Json.stringify(payload)).exceptionally(e -> null);
    }

    /** ack 为裸 boolean 或 {ok:boolean} 时统一取布尔。 */
    private boolean boolAck(String action, Object payload) {
        JsonElement el = req(action, payload);
        if (el != null && el.isJsonPrimitive() && el.getAsJsonPrimitive().isBoolean()) return el.getAsBoolean();
        return SemaJson.bool(el, "ok", false);
    }

    private MarketplacePluginsInfo plugin(String action, String pluginName, String marketplaceName,
                                          PluginScopeKind scope, String projectPath) {
        Map<String, Object> m = new HashMap<>();
        m.put("pluginName", pluginName);
        m.put("marketplaceName", marketplaceName);
        m.put("scope", scope);
        if (projectPath != null) m.put("projectPath", projectPath);
        return call(action, m, MarketplacePluginsInfo.class);
    }

    /** join 并把 CompletionException 解包为底层运行时异常（如 SemaBridgeException）。 */
    static String join(CompletableFuture<String> f) {
        try {
            return f.join();
        } catch (CompletionException e) {
            Throwable c = e.getCause();
            if (c instanceof RuntimeException re) throw re;
            throw e;
        }
    }
}

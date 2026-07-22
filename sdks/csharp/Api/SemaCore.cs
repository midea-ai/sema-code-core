using System.Text.Json;
using Semacore.Protocol;
using Semacore.Runtime;
using Semacore.Transport;
using Semacore.Types;

namespace Semacore;

/// <summary>
/// sema-core 的进程级镜像 API：用法与 Node 侧 <c>new SemaCore(config)</c> 一致（≙ Java semacore.SemaCore）。
///
/// <para><b>镜像原则</b>：方法名 = core 方法名（机械转 PascalCase，无语义偏差）、参数名 = core 参数名、
/// 事件名 = core 原始事件名（裸字符串订阅，不提供事件名常量）。入参 = <c>Semacore.Types</c> 强类型 DTO
/// （对象初始化器），返回值 = core 返回类型对应的强类型 DTO（wire 字段名 camelCase 与 core 完全一致）；
/// 事件回调 data 为 <see cref="JsonElement"/>，需要类型化时用 <c>Semacore.Events</c> DTO 自行反序列化。</para>
///
/// <para><b>异步形态</b>：Node 侧 <c>await</c> 的方法对应 <c>Task&lt;T&gt;</c>；Node 侧 void 的方法返回
/// <c>Task</c>（ack 送达即完成，纯送达确认）。</para>
///
/// <code>
/// // 一步式（推荐，≙ Node: new SemaCore({workingDir})；sidecar 由 SDK 托管，Close() 级联清理）
/// var core = await SemaCore.Start(new SemaCoreConfig { WorkingDir = dir, Thinking = true });
/// var session = await core.CreateSession();
/// session.On("message:text:chunk", data => Console.Write(SemaJson.Str(data, "delta")));
/// await session.ProcessUserInput("你好");
/// var model = await core.GetModelData();
/// await core.Close();
/// </code>
/// </summary>
public sealed class SemaCore : IAsyncDisposable
{
    /// <summary>桥协议版本；init ack 携带 protocolVersion，不等即快速失败（防 SDK 与 sidecar 产物漂移）。</summary>
    private const int PROTOCOL_VERSION = 1;

    private readonly SemaBridgeClient _client;
    /// <summary>Start() 托管的 sidecar；Attach 到外部连接时为 null（Close 不越权关别人的桥）。</summary>
    private readonly SidecarManager? _ownedSidecar;
    /// <summary>本 Core 注册的进程级监听器，支持 Off(event, handler)。</summary>
    private readonly List<(string Event, Action<JsonElement?> Handler, Registration Reg)> _subs = new();

    private SemaCore(SemaBridgeClient client, SidecarManager? ownedSidecar)
    {
        _client = client;
        _ownedSidecar = ownedSidecar;
    }

    // ── 获取实例（≙ Node: new SemaCore(config)，经桥 init，非破坏式）──────────

    /// <summary>
    /// 一步式入口：拉起托管 sidecar（node 自动供应、按需下载）→ 建连 → init → 版本握手。
    /// <c>WorkingDir</c> 从 config 读取（与 Node 一致），缺省当前目录。内置 180s 超时；
    /// <see cref="Close"/> 级联关闭 sidecar。
    /// 需要多连接 / 自定义 NodeProvider / 连接外部桥时，用 <see cref="SidecarManager"/> + Attach 的分步形态。
    /// </summary>
    public static async Task<SemaCore> Start(SemaCoreConfig? config = null)
    {
        var sidecar = new SidecarManager(workingDir: config?.WorkingDir);
        try
        {
            return await Attach(sidecar.NewClient(), config, sidecar)
                .WaitAsync(TimeSpan.FromSeconds(180)).ConfigureAwait(false);
        }
        catch
        {
            await sidecar.Close().ConfigureAwait(false);
            throw;
        }
    }

    /// <summary>经指定协议层客户端初始化 core；init ack 后完成（含协议版本握手）。</summary>
    public static Task<SemaCore> Attach(SemaBridgeClient client, SemaCoreConfig? config)
        => Attach(client, config, null);

    /// <summary>经指定连接初始化 core（未 Connect 会自动 Connect）。</summary>
    public static Task<SemaCore> Attach(BridgeConnection connection, SemaCoreConfig? config)
    {
        connection.Connect();
        return Attach(new SemaBridgeClient(connection), config);
    }

    private static async Task<SemaCore> Attach(SemaBridgeClient client, SemaCoreConfig? config,
        SidecarManager? ownedSidecar)
    {
        ArgumentNullException.ThrowIfNull(client);
        var ack = Json.Parse(await client.Call("init", Json.Stringify(config ?? new SemaCoreConfig())).ConfigureAwait(false));
        var bridgeVersion = SemaJson.I32(ack, "protocolVersion", -1);
        if (bridgeVersion != PROTOCOL_VERSION)
        {
            throw new SemaBridgeException("init",
                $"桥协议版本不匹配：SDK 需要 {PROTOCOL_VERSION}，sidecar 上报 "
                + (bridgeVersion == -1 ? "无（产物过旧）" : bridgeVersion.ToString())
                + "。请重新构建 sdks/shared/bridge（npm run build）并重装 SDK，保持二者同版本。");
        }
        return new SemaCore(client, ownedSidecar);
    }

    /// <summary>底层协议层客户端（哑转发 / 调试等场景的逃生口）。</summary>
    public SemaBridgeClient Client => _client;

    // ── 核心配置 ─────────────────────────────────────────────────────────

    public Task UpdateCoreConfig(UpdatableCoreConfig config)
        => VoidCall("updateCoreConfig", config);

    public Task UpdateCoreConfByKey(UpdatableCoreConfigKeys key, object? value)
        => VoidCall("updateCoreConfByKey", Json.Obj(("key", key), ("value", value)));

    /// <summary>更新全局禁用工具（黑名单）；toolNames 传 null 清空（须显式发 null，故手工拼 payload）。</summary>
    public Task UpdateDisabledTools(List<string>? toolNames)
        => _client.Call("updateDisabledTools", toolNames == null
            ? "{\"disabledTools\":null}"
            : Json.Stringify(Json.Obj(("disabledTools", toolNames))));

    // ── 模型管理 ─────────────────────────────────────────────────────────

    public Task<ModelUpdateData?> AddModel(ModelConfig config, bool? skipValidation = null)
        => Call<ModelUpdateData>("addModel", Json.Obj(("config", config), ("skipValidation", skipValidation)));

    public Task<ModelUpdateData?> DelModel(string modelName)
        => Call<ModelUpdateData>("delModel", Json.Obj(("modelName", modelName)));

    public Task<ModelUpdateData?> SwitchModel(string modelName)
        => Call<ModelUpdateData>("switchModel", Json.Obj(("modelName", modelName)));

    public Task<ModelUpdateData?> ApplyTaskModel(TaskConfig config)
        => Call<ModelUpdateData>("applyTaskModel", config);

    public Task<ModelUpdateData?> GetModelData()
        => Call<ModelUpdateData>("getModelData", null);

    public Task<FetchModelsResult?> FetchAvailableModels(FetchModelsParams @params)
        => Call<FetchModelsResult>("fetchAvailableModels", @params);

    public Task<ApiTestResult?> TestApiConnection(ApiTestParams @params)
        => Call<ApiTestResult>("testApiConnection", @params);

    public Task<AdapterType?> GetModelAdapter(string provider, string modelName, string baseURL)
        => Call<AdapterType?>("getModelAdapter",
            Json.Obj(("provider", provider), ("modelName", modelName), ("baseURL", baseURL)));

    // ── 会话 ─────────────────────────────────────────────────────────────

    public async Task<List<string>> ListSessions()
        => Json.ToList<string>(SemaJson.Get(await Req("listSessions", null).ConfigureAwait(false), "sessions"));

    public async Task<bool> SetActiveSession(string sessionId)
        => SemaJson.Bool(await Req("setActiveSession", Json.Obj(("sessionId", sessionId))).ConfigureAwait(false), "ok", false);

    public async Task<SemaSession> CreateSession(CreateSessionOptions? opts = null)
    {
        var data = await Req("createSession", opts).ConfigureAwait(false);
        var sessionId = SemaJson.Str(data, "sessionId")
            ?? throw new SemaBridgeException("createSession", "ack 缺少 sessionId");
        return new SemaSession(_client, sessionId);
    }

    /// <summary>已存在会话的本地句柄（不发指令；用于按 ListSessions 结果重新拿到会话对象）。</summary>
    public SemaSession Session(string sessionId)
        => new(_client, sessionId ?? throw new ArgumentNullException(nameof(sessionId)));

    /// <summary><see cref="Session"/> 的 core 同名别名。</summary>
    public SemaSession GetSession(string sessionId) => Session(sessionId);

    public async Task<bool> CloseSession(string sessionId)
    {
        ArgumentNullException.ThrowIfNull(sessionId);
        var ack = Json.Parse(await _client.Call("closeSession", null, sessionId).ConfigureAwait(false));
        return SemaJson.Bool(ack, "ok", false);
    }

    // ── 工具 ─────────────────────────────────────────────────────────────

    public Task<List<ToolInfo>> GetToolInfos()
        => CallList<ToolInfo>("getToolInfos", null);

    // ── 插件市场 ─────────────────────────────────────────────────────────

    public Task<MarketplacePluginsInfo?> GetMarketplacePluginsInfo()
        => Call<MarketplacePluginsInfo>("getMarketplacePluginsInfo", null);

    public Task<MarketplacePluginsInfo?> RefreshMarketplacePluginsInfo()
        => Call<MarketplacePluginsInfo>("refreshMarketplacePluginsInfo", null);

    public Task<MarketplacePluginsInfo?> AddMarketplaceFromGit(string repo)
        => Call<MarketplacePluginsInfo>("addMarketplaceFromGit", Json.Obj(("repo", repo)));

    public Task<MarketplacePluginsInfo?> AddMarketplaceFromDirectory(string dirPath)
        => Call<MarketplacePluginsInfo>("addMarketplaceFromDirectory", Json.Obj(("dirPath", dirPath)));

    public Task<MarketplacePluginsInfo?> UpdateMarketplace(string marketplaceName)
        => Call<MarketplacePluginsInfo>("updateMarketplace", Json.Obj(("marketplaceName", marketplaceName)));

    public Task<MarketplacePluginsInfo?> RemoveMarketplace(string marketplaceName)
        => Call<MarketplacePluginsInfo>("removeMarketplace", Json.Obj(("marketplaceName", marketplaceName)));

    public Task<MarketplacePluginsInfo?> InstallPlugin(string pluginName, string marketplaceName,
        PluginScopeKind scope, string? projectPath = null)
        => PluginCall("installPlugin", pluginName, marketplaceName, scope, projectPath);

    public Task<MarketplacePluginsInfo?> UninstallPlugin(string pluginName, string marketplaceName,
        PluginScopeKind scope, string? projectPath = null)
        => PluginCall("uninstallPlugin", pluginName, marketplaceName, scope, projectPath);

    public Task<MarketplacePluginsInfo?> EnablePlugin(string pluginName, string marketplaceName,
        PluginScopeKind scope, string? projectPath = null)
        => PluginCall("enablePlugin", pluginName, marketplaceName, scope, projectPath);

    public Task<MarketplacePluginsInfo?> DisablePlugin(string pluginName, string marketplaceName,
        PluginScopeKind scope, string? projectPath = null)
        => PluginCall("disablePlugin", pluginName, marketplaceName, scope, projectPath);

    public Task<MarketplacePluginsInfo?> UpdatePlugin(string pluginName, string marketplaceName,
        PluginScopeKind scope, string? projectPath = null)
        => PluginCall("updatePlugin", pluginName, marketplaceName, scope, projectPath);

    // ── Agents / Skills / Commands ───────────────────────────────────────

    public Task<List<AgentConfig>> GetAgentsInfo(bool? concise = null, bool? refresh = null)
        => CallList<AgentConfig>("getAgentsInfo", Json.Obj(("concise", concise), ("refresh", refresh)));

    public Task<List<AgentConfig>> AddAgentConf(AgentConfig agentConf)
        => CallList<AgentConfig>("addAgentConf", agentConf);

    public Task<List<AgentConfig>> RemoveAgentConf(string name)
        => CallList<AgentConfig>("removeAgentConf", Json.Obj(("name", name)));

    public Task<List<SkillConfig>> GetSkillsInfo(bool? concise = null, bool? refresh = null)
        => CallList<SkillConfig>("getSkillsInfo", Json.Obj(("concise", concise), ("refresh", refresh)));

    public Task<List<SkillConfig>> RemoveSkillConf(string name)
        => CallList<SkillConfig>("removeSkillConf", Json.Obj(("name", name)));

    public Task<List<CommandConfig>> GetCommandsInfo(bool? concise = null, bool? refresh = null)
        => CallList<CommandConfig>("getCommandsInfo", Json.Obj(("concise", concise), ("refresh", refresh)));

    public Task<List<CommandConfig>> AddCommandConf(CommandConfig commandConf)
        => CallList<CommandConfig>("addCommandConf", commandConf);

    public Task<List<CommandConfig>> RemoveCommandConf(string name)
        => CallList<CommandConfig>("removeCommandConf", Json.Obj(("name", name)));

    // ── MCP ──────────────────────────────────────────────────────────────

    public Task<List<MCPServerInfo>> GetMCPServerInfo()
        => CallList<MCPServerInfo>("getMCPServerInfo", null);

    public Task<List<MCPServerInfo>> RefreshMCPServerInfo()
        => CallList<MCPServerInfo>("refreshMCPServerInfo", null);

    public Task<List<MCPServerInfo>> AddMCPServer(MCPServerConfig mcpConfig)
        => CallList<MCPServerInfo>("addMCPServer", mcpConfig);

    public Task<List<MCPServerInfo>> RemoveMCPServer(string name)
        => CallList<MCPServerInfo>("removeMCPServer", Json.Obj(("name", name)));

    public Task<List<MCPServerInfo>> ReconnectMCPServer(string name)
        => CallList<MCPServerInfo>("reconnectMCPServer", Json.Obj(("name", name)));

    public Task<List<MCPServerInfo>> DisableMCPServer(string name)
        => CallList<MCPServerInfo>("disableMCPServer", Json.Obj(("name", name)));

    public Task<List<MCPServerInfo>> EnableMCPServer(string name)
        => CallList<MCPServerInfo>("enableMCPServer", Json.Obj(("name", name)));

    public Task<List<MCPServerInfo>> UpdateMCPUseTools(string name, List<string> toolNames)
        => CallList<MCPServerInfo>("updateMCPUseTools", Json.Obj(("name", name), ("toolNames", toolNames)));

    // ── Cron ─────────────────────────────────────────────────────────────

    public Task<List<CronTask>> GetCronTasks()
        => CallList<CronTask>("getCronTasks", null);

    public Task<bool> DeleteCronTask(string id)
        => BoolAck("deleteCronTask", Json.Obj(("id", id)));

    public Task<bool> EnableCronTask(string id)
        => BoolAck("enableCronTask", Json.Obj(("id", id)));

    public Task<bool> DisableCronTask(string id)
        => BoolAck("disableCronTask", Json.Obj(("id", id)));

    // ── Memory / Rules / Design ──────────────────────────────────────────

    public Task<MemoryConfig?> GetMemoryInfo(bool? refresh = null)
        => Call<MemoryConfig>("getMemoryInfo", Json.Obj(("refresh", refresh)));

    public Task<RuleConfig?> GetRuleInfo(bool? refresh = null)
        => Call<RuleConfig>("getRuleInfo", Json.Obj(("refresh", refresh)));

    public Task<List<DesignSkillInfo>> GetDesignSkillsInfo(bool? refresh = null)
        => CallList<DesignSkillInfo>("getDesignSkillsInfo", Json.Obj(("refresh", refresh)));

    public Task<List<DesignSystemInfo>> GetDesignSystemsInfo(bool? refresh = null)
        => CallList<DesignSystemInfo>("getDesignSystemsInfo", Json.Obj(("refresh", refresh)));

    // ── 进程级事件（cron:update / mcp:server:status 等；不绑定 sessionId）──

    /// <summary>订阅进程级事件（事件名为 core 原始名）；data 为 JSON 级事件数据，需要类型化用 Semacore.Events DTO 反序列化。</summary>
    public Registration On(string @event, Action<JsonElement?> handler)
    {
        var reg = _client.On(@event, "", (data, _) => handler(Json.Parse(data)));
        _subs.Add((@event, handler, reg));
        return reg;
    }

    public Registration Once(string @event, Action<JsonElement?> handler)
    {
        var reg = _client.Once(@event, "", (data, _) => handler(Json.Parse(data)));
        _subs.Add((@event, handler, reg));
        return reg;
    }

    /// <summary>按 (event, handler) 取消订阅（≙ Node off）；移除首个匹配的 On/Once 注册。</summary>
    public void Off(string @event, Action<JsonElement?> handler)
    {
        for (var i = 0; i < _subs.Count; i++)
        {
            if (_subs[i].Event == @event && ReferenceEquals(_subs[i].Handler, handler))
            {
                _subs[i].Reg.Unregister();
                _subs.RemoveAt(i);
                return;
            }
        }
    }

    /// <summary>
    /// ≙ Node 的 <c>core.dispose()</c>：关闭底层连接；<see cref="Start"/> 创建的实例级联停掉托管 sidecar。
    /// Attach 到外部连接/桥的实例只关自己的连接，进程生命周期归其 SidecarManager 管。
    /// </summary>
    public async Task Close()
    {
        await _client.Close().ConfigureAwait(false);
        if (_ownedSidecar != null)
        {
            try
            {
                await _ownedSidecar.Close().ConfigureAwait(false);
            }
            catch
            {
                // 退出路径尽力而为
            }
        }
    }

    public ValueTask DisposeAsync() => new(Close());

    // ── 内部 ─────────────────────────────────────────────────────────────

    /// <summary>请求并解析 ack data（空 ack 为 null）。</summary>
    private async Task<JsonElement?> Req(string action, object? payload)
        => Json.Parse(await _client.Call(action, Json.Stringify(payload)).ConfigureAwait(false));

    private async Task<T?> Call<T>(string action, object? payload)
        => Json.To<T>(await Req(action, payload).ConfigureAwait(false));

    private async Task<List<T>> CallList<T>(string action, object? payload)
        => Json.ToList<T>(await Req(action, payload).ConfigureAwait(false));

    /// <summary>Node void 语义：等 ack 送达即完成（纯送达确认，无返回数据）。</summary>
    private Task VoidCall(string action, object? payload)
        => _client.Call(action, Json.Stringify(payload));

    /// <summary>ack 为裸 boolean 或 {ok:boolean} 时统一取布尔。</summary>
    private async Task<bool> BoolAck(string action, object? payload)
    {
        var el = await Req(action, payload).ConfigureAwait(false);
        if (el is { ValueKind: JsonValueKind.True }) return true;
        if (el is { ValueKind: JsonValueKind.False }) return false;
        return SemaJson.Bool(el, "ok", false);
    }

    private Task<MarketplacePluginsInfo?> PluginCall(string action, string pluginName, string marketplaceName,
        PluginScopeKind scope, string? projectPath)
        => Call<MarketplacePluginsInfo>(action, Json.Obj(
            ("pluginName", pluginName),
            ("marketplaceName", marketplaceName),
            ("scope", scope),
            ("projectPath", projectPath)));
}

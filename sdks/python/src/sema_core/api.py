"""api 层：sema-core 的镜像 API（≙ Java api/SemaCore、api/SemaSession）。

镜像原则：方法名 = core 方法名（PEP 8 机械转 snake_case，无语义偏差）、参数名 =
core 参数名、事件名 = core 原始事件名；payload / 返回值为 dict（JSON 级一致，字段
名与 core 相同，camelCase 不转换）。类型化 DTO 定义在 types.py（配置/参数/返回）与
event.py（事件数据）：TypedDict，键即 wire 字段名、运行时仍是普通 dict；本层方法签名
引用它们提供补全，运行时行为不变。事件回调数据类型见 event.py（如 `d: TextChunkData`）。

    # 一步式（推荐，≙ Node: new SemaCore({workingDir})；sidecar 由 SDK 托管）
    core = await SemaCore.start({"workingDir": project_dir})
    session = await core.create_session()
    session.on("message:text:chunk", lambda d: print(d["delta"], end=""))
    await session.process_user_input("你好")
    await core.close()
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Callable, List, Optional, Union

from . import events as SemaEvents
from .constants import PROTOCOL_VERSION
from .protocol import Registration, SemaBridgeClient, SemaBridgeException
from .transport import BridgeConnection

if TYPE_CHECKING:
    # 仅类型注解引用（配合 from __future__ import annotations，运行时不导入、无环、零开销）
    from .types import (
        AdapterType, AgentConfig, AgentMode, ApiTestParams, ApiTestResult, BranchResult,
        CommandConfig, CreateSessionOptions, CronTask, DesignSkillInfo, DesignSystemInfo,
        FetchModelsParams, FetchModelsResult, ForkOptions, ForkPreview, ForkResult,
        HooksInfo, InputImageAttachment, MarketplacePluginsInfo, MCPServerConfig,
        MCPServerInfo, MemoryConfig, ModelConfig, ModelUpdateData, PermissionLevel,
        RuleConfig, SemaCoreConfig, SkillConfig, TaskConfig, TaskListItem, ToolInfo,
    )
    from .event import PickOptionResponseData, PlanExitResponseData, ToolPermissionResponse

Json = Optional[dict]
Handler = Callable[[Any], Any]


def _obj(**kwargs: Any) -> dict:
    """构造 payload：值为 None 的键跳过（可选参数不发送，≙ Java Json.obj）。"""
    return {k: v for k, v in kwargs.items() if v is not None}


def _parse(data: str) -> Any:
    return json.loads(data) if data else None


class SemaCore:
    """进程级镜像 API：用法与 Node 侧 `new SemaCore(config)` 一致。"""

    def __init__(self, client: SemaBridgeClient, owned_sidecar: Any = None) -> None:
        # 内部构造；请用 SemaCore.start / SemaCore.attach
        self._client = client
        self._owned_sidecar = owned_sidecar  # start() 托管的 sidecar；attach 时为 None
        self._subs: List[tuple] = []  # (event, handler, Registration)，支持 off(event, handler)

    # ── 获取实例（≙ Node: new SemaCore(config)，经桥 init，非破坏式）──────

    @classmethod
    async def start(cls, config: Optional["SemaCoreConfig"] = None) -> "SemaCore":
        """一步式入口：拉起托管 sidecar → 建连 → init → 版本握手；close() 级联关闭 sidecar。

        workingDir 从 config 读取（与 Node 一致），缺省当前目录。需要多连接 /
        自定义 node_provider / 连接外部桥时，用 SidecarManager + attach 的分步形态。
        """
        from .runtime import SidecarManager  # 延迟导入避免环
        sidecar = SidecarManager(working_dir=(config or {}).get("workingDir"))
        try:
            return await cls.attach(sidecar.new_client(), config, _owned_sidecar=sidecar)
        except BaseException:
            await sidecar.close()
            raise

    @classmethod
    async def attach(cls, client_or_connection: Union[SemaBridgeClient, BridgeConnection],
                     config: Optional["SemaCoreConfig"] = None, *, _owned_sidecar: Any = None) -> "SemaCore":
        """经指定协议层客户端/连接初始化 core；init ack 后完成（含协议版本握手）。"""
        if isinstance(client_or_connection, BridgeConnection):
            client_or_connection.connect()
            client = SemaBridgeClient(client_or_connection)
        else:
            client = client_or_connection
        ack = _parse(await client.call("init", json.dumps(config or {})))
        bridge_version = (ack or {}).get("protocolVersion", -1)
        if bridge_version != PROTOCOL_VERSION:
            raise SemaBridgeException("init", (
                f"桥协议版本不匹配：SDK 需要 {PROTOCOL_VERSION}，sidecar 上报 "
                f"{'无（产物过旧）' if bridge_version == -1 else bridge_version}。"
                "请重新构建 sdks/shared/bridge（npm run build）并重装 SDK，保持二者同版本。"))
        return cls(client, _owned_sidecar)

    @property
    def client(self) -> SemaBridgeClient:
        """底层协议层客户端（哑转发 / 调试等场景的逃生口）。"""
        return self._client

    # ── 核心配置 ─────────────────────────────────────────────────────────

    async def update_core_config(self, config: "SemaCoreConfig") -> None:
        await self._client.call("updateCoreConfig", json.dumps(config))

    async def update_core_conf_by_key(self, key: str, value: Any) -> None:
        await self._client.call("updateCoreConfByKey", json.dumps({"key": key, "value": value}))

    # ── 模型管理 ─────────────────────────────────────────────────────────

    async def add_model(self, config: "ModelConfig", skip_validation: Optional[bool] = None) -> "ModelUpdateData":
        return await self._json("addModel", _obj(config=config, skipValidation=skip_validation))

    async def del_model(self, model_name: str) -> "ModelUpdateData":
        return await self._json("delModel", {"modelName": model_name})

    async def switch_model(self, model_name: str) -> "ModelUpdateData":
        return await self._json("switchModel", {"modelName": model_name})

    async def apply_task_model(self, config: "TaskConfig") -> "ModelUpdateData":
        """config: {main, quick}（与 core 的 applyTaskModel 参数一致）。"""
        return await self._json("applyTaskModel", config)

    async def get_model_data(self) -> "ModelUpdateData":
        return await self._json("getModelData", None)

    async def fetch_available_models(self, params: "FetchModelsParams") -> "FetchModelsResult":
        return await self._json("fetchAvailableModels", params)

    async def test_api_connection(self, params: "ApiTestParams") -> "ApiTestResult":
        return await self._json("testApiConnection", params)

    async def get_model_adapter(self, provider: str, model_name: str, base_url: str) -> "AdapterType":
        return await self._json("getModelAdapter",
                                _obj(provider=provider, modelName=model_name, baseURL=base_url))

    # ── 会话 ─────────────────────────────────────────────────────────────

    async def list_sessions(self) -> "List[str]":
        ack = await self._json("listSessions", None)
        return (ack or {}).get("sessions", [])

    async def set_active_session(self, session_id: str) -> bool:
        ack = await self._json("setActiveSession", {"sessionId": session_id})
        return bool((ack or {}).get("ok"))

    async def create_session(self, opts: Optional["CreateSessionOptions"] = None) -> "SemaSession":
        """opts 可选 {sessionId, permissionLevel, agentMode, mainModel, quickModel}（字段名与 core createSession 一致；mainModel/quickModel 为会话级模型覆盖，不持久化）。"""
        data = await self._json("createSession", opts or {})
        return SemaSession(self._client, data["sessionId"])

    def session(self, session_id: str) -> "SemaSession":
        """按已知 sessionId 构造会话句柄（不发起创建）。"""
        return SemaSession(self._client, session_id)

    get_session = session

    async def close_session(self, session_id: str) -> bool:
        ack = _parse(await self._client.call("closeSession", None, session_id))
        return bool((ack or {}).get("ok"))

    # ── 工具 ─────────────────────────────────────────────────────────────

    async def get_tool_infos(self) -> "List[ToolInfo]":
        return await self._json("getToolInfos", None)

    async def update_disabled_tools(self, tool_names: Optional[list[str]] = None) -> None:
        """tool_names 传 None 清空全局禁用（≙ core updateDisabledTools(toolNames | null)）。"""
        await self._client.call("updateDisabledTools", json.dumps({"disabledTools": tool_names}))

    # ── 历史清理 ─────────────────────────────────────────────────────────

    async def delete_session_history(self, session_id: str, project_path: Optional[str] = None) -> None:
        """删除单个会话的 core 落盘历史文件（宿主删除历史条目后同步清理）。"""
        await self._call("deleteSessionHistory", _obj(sessionId=session_id, projectPath=project_path))

    async def delete_project_history(self, project_path: str) -> None:
        """删除指定项目的全部历史与快照目录。"""
        await self._call("deleteProjectHistory", {"projectPath": project_path})

    # ── 插件市场 ─────────────────────────────────────────────────────────

    async def get_marketplace_plugins_info(self) -> "MarketplacePluginsInfo":
        return await self._json("getMarketplacePluginsInfo", None)

    async def refresh_marketplace_plugins_info(self) -> "MarketplacePluginsInfo":
        return await self._json("refreshMarketplacePluginsInfo", None)

    async def add_marketplace_from_git(self, repo: str) -> "MarketplacePluginsInfo":
        return await self._json("addMarketplaceFromGit", {"repo": repo})

    async def add_marketplace_from_directory(self, dir_path: str) -> "MarketplacePluginsInfo":
        return await self._json("addMarketplaceFromDirectory", {"dirPath": dir_path})

    async def update_marketplace(self, marketplace_name: str) -> "MarketplacePluginsInfo":
        return await self._json("updateMarketplace", {"marketplaceName": marketplace_name})

    async def remove_marketplace(self, marketplace_name: str) -> "MarketplacePluginsInfo":
        return await self._json("removeMarketplace", {"marketplaceName": marketplace_name})

    async def install_plugin(self, plugin_name: str, marketplace_name: str,
                             scope: str, project_path: Optional[str] = None) -> "MarketplacePluginsInfo":
        return await self._plugin("installPlugin", plugin_name, marketplace_name, scope, project_path)

    async def uninstall_plugin(self, plugin_name: str, marketplace_name: str,
                               scope: str, project_path: Optional[str] = None) -> "MarketplacePluginsInfo":
        return await self._plugin("uninstallPlugin", plugin_name, marketplace_name, scope, project_path)

    async def enable_plugin(self, plugin_name: str, marketplace_name: str,
                            scope: str, project_path: Optional[str] = None) -> "MarketplacePluginsInfo":
        return await self._plugin("enablePlugin", plugin_name, marketplace_name, scope, project_path)

    async def disable_plugin(self, plugin_name: str, marketplace_name: str,
                             scope: str, project_path: Optional[str] = None) -> "MarketplacePluginsInfo":
        return await self._plugin("disablePlugin", plugin_name, marketplace_name, scope, project_path)

    async def update_plugin(self, plugin_name: str, marketplace_name: str,
                            scope: str, project_path: Optional[str] = None) -> "MarketplacePluginsInfo":
        return await self._plugin("updatePlugin", plugin_name, marketplace_name, scope, project_path)

    # ── Agents / Skills / Commands ───────────────────────────────────────

    async def get_agents_info(self, concise: Optional[bool] = None, refresh: Optional[bool] = None) -> "List[AgentConfig]":
        return await self._json("getAgentsInfo", _obj(concise=concise, refresh=refresh))

    async def add_agent_conf(self, agent_conf: "AgentConfig") -> "List[AgentConfig]":
        return await self._json("addAgentConf", agent_conf)

    async def remove_agent_conf(self, name: str) -> "List[AgentConfig]":
        return await self._json("removeAgentConf", {"name": name})

    async def get_skills_info(self, concise: Optional[bool] = None, refresh: Optional[bool] = None) -> "List[SkillConfig]":
        return await self._json("getSkillsInfo", _obj(concise=concise, refresh=refresh))

    async def remove_skill_conf(self, name: str) -> "List[SkillConfig]":
        return await self._json("removeSkillConf", {"name": name})

    async def get_commands_info(self, concise: Optional[bool] = None, refresh: Optional[bool] = None) -> "List[CommandConfig]":
        return await self._json("getCommandsInfo", _obj(concise=concise, refresh=refresh))

    async def add_command_conf(self, command_conf: "CommandConfig") -> "List[CommandConfig]":
        return await self._json("addCommandConf", command_conf)

    async def remove_command_conf(self, name: str) -> "List[CommandConfig]":
        return await self._json("removeCommandConf", {"name": name})

    # ── MCP ──────────────────────────────────────────────────────────────

    async def get_mcp_server_info(self) -> "List[MCPServerInfo]":
        return await self._json("getMCPServerInfo", None)

    async def refresh_mcp_server_info(self) -> "List[MCPServerInfo]":
        return await self._json("refreshMCPServerInfo", None)

    async def add_mcp_server(self, mcp_config: "MCPServerConfig") -> "List[MCPServerInfo]":
        return await self._json("addMCPServer", mcp_config)

    async def remove_mcp_server(self, name: str) -> "List[MCPServerInfo]":
        return await self._json("removeMCPServer", {"name": name})

    async def reconnect_mcp_server(self, name: str) -> "List[MCPServerInfo]":
        return await self._json("reconnectMCPServer", {"name": name})

    async def disable_mcp_server(self, name: str) -> "List[MCPServerInfo]":
        return await self._json("disableMCPServer", {"name": name})

    async def enable_mcp_server(self, name: str) -> "List[MCPServerInfo]":
        return await self._json("enableMCPServer", {"name": name})

    async def update_mcp_use_tools(self, name: str, tool_names: list[str]) -> "List[MCPServerInfo]":
        return await self._json("updateMCPUseTools", {"name": name, "toolNames": tool_names})

    # ── Cron ─────────────────────────────────────────────────────────────

    async def get_cron_tasks(self) -> "List[CronTask]":
        return await self._json("getCronTasks", None)

    async def delete_cron_task(self, id: str) -> bool:
        return await self._json("deleteCronTask", {"id": id})

    async def enable_cron_task(self, id: str) -> bool:
        return await self._json("enableCronTask", {"id": id})

    async def disable_cron_task(self, id: str) -> bool:
        return await self._json("disableCronTask", {"id": id})

    # ── 只读信息 ─────────────────────────────────────────────────────────

    async def get_memory_info(self, refresh: Optional[bool] = None) -> Optional["MemoryConfig"]:
        return await self._json("getMemoryInfo", _obj(refresh=refresh))

    async def get_rule_info(self, refresh: Optional[bool] = None) -> Optional["RuleConfig"]:
        return await self._json("getRuleInfo", _obj(refresh=refresh))

    async def get_hooks_info(self, refresh: Optional[bool] = None) -> "HooksInfo":
        return await self._json("getHooksInfo", _obj(refresh=refresh))

    async def get_design_skills_info(self, refresh: Optional[bool] = None) -> "List[DesignSkillInfo]":
        return await self._json("getDesignSkillsInfo", _obj(refresh=refresh))

    async def get_design_systems_info(self, refresh: Optional[bool] = None) -> "List[DesignSystemInfo]":
        return await self._json("getDesignSystemsInfo", _obj(refresh=refresh))

    # ── 进程级事件 ───────────────────────────────────────────────────────

    def on(self, event: str, handler: Handler) -> Registration:
        """订阅进程级事件；handler(data)，data 为 JSON 级事件数据（dict/list/None）。
        取消订阅用返回的 Registration.unregister() 或 off(event, handler)（≙ Node off）。"""
        reg = self._client.on(event, lambda data, _sid: handler(_parse(data)), "")
        self._subs.append((event, handler, reg))
        return reg

    def once(self, event: str, handler: Handler) -> Registration:
        reg = self._client.once(event, lambda data, _sid: handler(_parse(data)), "")
        self._subs.append((event, handler, reg))
        return reg

    def off(self, event: str, handler: Handler) -> None:
        """按 (event, handler) 取消订阅（≙ Node off）；移除首个匹配的 on/once 注册。"""
        for i, (e, h, reg) in enumerate(self._subs):
            if e == event and h == handler:
                reg.unregister()
                self._subs.pop(i)
                return

    async def close(self) -> None:
        """≙ Node core.dispose()：关闭连接；start() 创建的实例级联停掉托管 sidecar。"""
        await self._client.close()
        if self._owned_sidecar is not None:
            try:
                await self._owned_sidecar.close()
            except Exception:
                pass

    # ── 内部 ─────────────────────────────────────────────────────────────

    async def _json(self, action: str, payload: Json) -> Any:
        return _parse(await self._client.call(action, json.dumps(payload) if payload is not None else None))

    async def _plugin(self, action: str, plugin_name: str, marketplace_name: str,
                      scope: Optional[str], project_path: Optional[str]) -> Any:
        return await self._json(action, _obj(pluginName=plugin_name, marketplaceName=marketplace_name,
                                             scope=scope, projectPath=project_path))


class SemaSession:
    """会话级镜像 API；事件订阅自动按 sessionId 过滤，session:ready 缓存重放。"""

    def __init__(self, client: SemaBridgeClient, session_id: str) -> None:
        self._client = client
        self._session_id = session_id
        self._ready_data: Optional[str] = None  # 创建期事件缓存：晚订阅也不丢
        self._subs: List[tuple] = []  # (event, handler, Registration)，支持 off(event, handler)
        self._client.once(SemaEvents.SESSION_READY,
                          self._cache_ready, session_id)

    def _cache_ready(self, data: str, _sid: str) -> None:
        self._ready_data = data if data else "{}"

    @property
    def session_id(self) -> str:
        return self._session_id

    # ── 会话交互 ─────────────────────────────────────────────────────────

    async def process_user_input(self, input: str, original_input: Optional[str] = None,
                                 attachments: Optional["List[InputImageAttachment]"] = None) -> None:
        # 形参名对齐 core（input / originalInput）；wire 键仍为桥内部的 content / orgContent
        await self._call("processUserInput",
                         _obj(content=input, orgContent=original_input, attachments=attachments))

    async def interrupt(self) -> None:
        await self._call("interrupt", None)

    async def respond_to_tool_permission(self, response: "ToolPermissionResponse") -> None:
        await self._call("respondToToolPermission", response)

    async def respond_to_pick_option(self, response: "PickOptionResponseData") -> None:
        await self._call("respondToPickOption", response)

    async def respond_to_plan_exit(self, response: "PlanExitResponseData") -> None:
        await self._call("respondToPlanExit", response)

    async def update_agent_mode(self, mode: "AgentMode") -> None:
        await self._call("updateAgentMode", {"mode": mode})

    async def update_permission_level(self, level: "PermissionLevel") -> None:
        await self._call("updatePermissionLevel", {"level": level})

    async def get_fork_preview(self, message_uuid: str) -> "ForkPreview":
        return _parse(await self._call("getForkPreview", {"messageUuid": message_uuid}))

    async def fork(self, message_uuid: str, options: Optional["ForkOptions"] = None) -> "ForkResult":
        return _parse(await self._call("fork", _obj(messageUuid=message_uuid, options=options)))

    async def branch(self, before_message_uuid: Optional[str] = None) -> "BranchResult":
        """分支到新聊天：复制截断历史到新会话（源会话与工作区不动）；锚点缺省则全量复制。"""
        return _parse(await self._call("branch", _obj(beforeMessageUuid=before_message_uuid)))

    # ── 后台任务 ─────────────────────────────────────────────────────────

    async def stop_all_tasks(self) -> int:
        ack = _parse(await self._call("stopAllTasks", None))
        return (ack or {}).get("count", 0)

    async def get_task_list(self) -> "List[TaskListItem]":
        return _parse(await self._call("getTaskList", None))

    async def stop_task(self, task_id: str) -> bool:
        ack = _parse(await self._call("stopTask", {"taskId": task_id}))
        return bool((ack or {}).get("ok"))

    async def transfer_agent_to_background(self, task_id: str) -> bool:
        ack = _parse(await self._call("transferAgentToBackground", {"taskId": task_id}))
        return bool((ack or {}).get("ok"))

    async def transfer_all_foreground_agents(self) -> "List[str]":
        ack = _parse(await self._call("transferAllForegroundAgents", None))
        return (ack or {}).get("taskIds", [])

    def watch_task(self, task_id: str, on_delta: Callable[[str], Any]) -> Registration:
        """订阅任务增量（task:watch:delta 合成事件）；unregister 时发 unwatchTask。"""
        import asyncio

        def forward(data: str, _sid: str) -> None:
            parsed = _parse(data) or {}
            if parsed.get("taskId") == task_id:
                on_delta(parsed.get("delta", ""))

        reg = self._client.on(SemaEvents.TASK_WATCH_DELTA, forward, self._session_id)
        asyncio.ensure_future(self._call("watchTask", {"taskId": task_id}))

        def unregister() -> None:
            reg.unregister()
            asyncio.ensure_future(self._call("unwatchTask", {"taskId": task_id}))

        return Registration(unregister)

    # ── 事件 ─────────────────────────────────────────────────────────────

    def on(self, event: str, handler: Handler) -> Registration:
        """订阅本会话事件；handler(data)。session:ready 走缓存重放（晚订阅也不丢）。
        取消订阅用返回的 Registration.unregister() 或 off(event, handler)（≙ Node off）。"""
        if event == SemaEvents.SESSION_READY and self._ready_data is not None:
            handler(_parse(self._ready_data))
        reg = self._client.on(event, lambda data, _sid: handler(_parse(data)), self._session_id)
        self._subs.append((event, handler, reg))
        return reg

    def once(self, event: str, handler: Handler) -> Registration:
        if event == SemaEvents.SESSION_READY and self._ready_data is not None:
            handler(_parse(self._ready_data))
            return Registration(lambda: None)
        reg = self._client.once(event, lambda data, _sid: handler(_parse(data)), self._session_id)
        self._subs.append((event, handler, reg))
        return reg

    def off(self, event: str, handler: Handler) -> None:
        """按 (event, handler) 取消订阅（≙ Node off）；移除首个匹配的 on/once 注册。"""
        for i, (e, h, reg) in enumerate(self._subs):
            if e == event and h == handler:
                reg.unregister()
                self._subs.pop(i)
                return

    async def wait_for(self, event: str, timeout: Optional[float] = None,
                       predicate: Optional[Callable[[Any], bool]] = None) -> Any:
        """等待本会话事件（可选 predicate 对解析后的 data 过滤），返回 JSON 级数据。"""
        if event == SemaEvents.SESSION_READY and self._ready_data is not None:
            data = _parse(self._ready_data)
            if predicate is None or predicate(data):
                return data
        raw_predicate = None if predicate is None else (lambda raw: predicate(_parse(raw)))
        raw = await self._client.wait_for(event, self._session_id, timeout, raw_predicate)
        return _parse(raw)

    async def close(self) -> bool:
        """= core.close_session(session_id)。"""
        ack = _parse(await self._client.call("closeSession", None, self._session_id))
        return bool((ack or {}).get("ok"))

    # ── 内部 ─────────────────────────────────────────────────────────────

    async def _call(self, action: str, payload: Json) -> str:
        return await self._client.call(
            action, json.dumps(payload) if payload is not None else None, self._session_id)

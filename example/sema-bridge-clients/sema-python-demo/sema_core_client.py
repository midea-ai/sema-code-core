import asyncio
import json
from collections import defaultdict
from typing import Any, Callable, Optional

import websockets

from bridge_command import BridgeCommand
from bridge_event import BridgeEvent
from sema_core_config import SemaCoreConfig


class SemaCoreClient:
    """sema-core Python 客户端

    通过 WebSocket 连接桥接服务，提供与 sema-core 的全双工通信能力。
    """

    def __init__(self) -> None:
        self._ws = None
        self._pending: dict[str, asyncio.Future] = {}
        self._handlers: dict[str, list[Callable]] = defaultdict(list)

    # ── 事件订阅 ──────────────────────────────────────────────────

    def on(self, event: str, handler: Callable) -> None:
        """注册事件处理器"""
        self._handlers[event].append(handler)

    def once(self, event: str, handler: Callable) -> None:
        """注册一次性事件处理器（触发后自动注销）"""
        wrapper_ref: list[Optional[Callable]] = [None]

        def wrapper(data: Any) -> Any:
            handler(data)
            handlers = self._handlers.get(event, [])
            if wrapper_ref[0] in handlers:
                handlers.remove(wrapper_ref[0])

        wrapper_ref[0] = wrapper
        self._handlers[event].append(wrapper)

    async def wait_for_event(self, event: str, timeout: float = 30.0) -> Any:
        """等待某个事件触发并返回其 data（对应 Java 的 CompletableFuture + once 模式）"""
        future: asyncio.Future = asyncio.get_event_loop().create_future()

        def handler(data: Any) -> None:
            if not future.done():
                future.set_result(data)

        self.once(event, handler)
        return await asyncio.wait_for(future, timeout=timeout)

    # ── 连接 ──────────────────────────────────────────────────────

    async def connect(self, url: str) -> None:
        """连接到 sema-bridge 桥接服务"""
        self._ws = await websockets.connect(url)
        asyncio.ensure_future(self._receive_loop())

    # ── 接收分发 ──────────────────────────────────────────────────

    async def _receive_loop(self) -> None:
        try:
            async for message in self._ws:
                self._dispatch(message)
        except Exception as e:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(e)
            self._pending.clear()

    def _dispatch(self, text: str) -> None:
        try:
            d = json.loads(text)
            evt = BridgeEvent.from_dict(d)

            # 处理指令响应（ack / error with cmdId）
            if evt.cmd_id and evt.cmd_id in self._pending:
                future = self._pending.pop(evt.cmd_id)
                if not future.done():
                    if evt.event == "error":
                        msg = "Unknown error"
                        if isinstance(evt.data, dict) and "message" in evt.data:
                            msg = evt.data["message"]
                        future.set_exception(RuntimeError(msg))
                    else:
                        future.set_result(evt)

            # 分发推送事件给订阅的处理器
            for handler in list(self._handlers.get(evt.event, [])):
                result = handler(evt.data)
                if asyncio.iscoroutine(result):
                    asyncio.ensure_future(result)

        except Exception as e:
            print(f"[SemaCoreClient] Receive error: {e}")

    # ── 发送指令 ──────────────────────────────────────────────────

    async def send_command(
        self, action: str, payload: Any = None, timeout: float = 15.0
    ) -> BridgeEvent:
        """发送指令并等待响应（ack 或 error）"""
        cmd = BridgeCommand(action=action, payload=payload)
        future: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending[cmd.id] = future
        await self._ws.send(cmd.to_json())
        return await asyncio.wait_for(future, timeout=timeout)

    # ── 高级封装 API ──────────────────────────────────────────────

    async def init_core(self, config: SemaCoreConfig) -> BridgeEvent:
        """初始化核心配置（在 create_session 之前调用）"""
        return await self.send_command("config.init", config.to_dict())

    async def create_session(self, session_id: Optional[str] = None) -> BridgeEvent:
        """创建或恢复会话"""
        payload = {"sessionId": session_id} if session_id else None
        return await self.send_command("session.create", payload)

    async def send_user_input(self, content: str) -> BridgeEvent:
        """发送用户消息"""
        return await self.send_command("session.input", {"content": content})

    async def interrupt(self) -> BridgeEvent:
        """中断当前处理"""
        return await self.send_command("session.interrupt")

    async def respond_to_permission(self, tool_id: str, tool_name: str, selected: str) -> BridgeEvent:
        """响应工具权限请求"""
        return await self.send_command(
            "permission.respond", {"toolId": tool_id, "toolName": tool_name, "selected": selected}
        )

    async def respond_to_question(self, agent_id: str, answers: dict[str, str]) -> BridgeEvent:
        """响应问答请求"""
        return await self.send_command("question.respond", {"agentId": agent_id, "answers": answers})

    async def respond_to_plan_exit(self, agent_id: str, selected: str) -> BridgeEvent:
        """响应计划退出请求"""
        return await self.send_command("plan.respond", {"agentId": agent_id, "selected": selected})

    async def add_model(self, config: dict, skip_validation: bool = False) -> BridgeEvent:
        """添加模型"""
        return await self.send_command(
            "model.add", {"config": config, "skipValidation": skip_validation}
        )

    async def apply_task_model(self, main: str, quick: str) -> BridgeEvent:
        """应用任务模型配置（main / quick 使用的模型 ID）"""
        return await self.send_command("model.applyTask", {"main": main, "quick": quick})

    async def del_model(self, model_name: str) -> BridgeEvent:
        """删除模型"""
        return await self.send_command("model.del", {"modelName": model_name})

    async def switch_model(self, model_name: str) -> BridgeEvent:
        """切换模型"""
        return await self.send_command("model.switch", {"modelName": model_name})

    async def get_model_data(self) -> BridgeEvent:
        """获取模型信息"""
        return await self.send_command("model.getData")

    async def set_agent_mode(self, mode: str) -> BridgeEvent:
        """设置代理模式（Agent / Plan）"""
        return await self.send_command("config.updateAgentMode", {"mode": mode})

    async def update_config(self, config: dict) -> BridgeEvent:
        """更新运行时配置（会话创建后也可调用）"""
        return await self.send_command("config.update", config)

    async def dispose_session(self) -> BridgeEvent:
        """销毁会话"""
        return await self.send_command("session.dispose")

    async def close(self) -> None:
        if self._ws:
            await self._ws.close()

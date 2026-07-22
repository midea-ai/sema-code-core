"""protocol 层：指令/响应匹配 + 事件分发（镜像 Java protocol/SemaBridgeClient）。

- call(action, payload_json, session_id) 返回 awaitable：ack → data 字符串，error → SemaBridgeException；
- 断线（RECONNECTING/CLOSED）时在途 call 立即失败；
- on / once / wait_for 按事件名 + session_id 订阅（session_id="" 表进程级）；
- 所有回调在连接读循环里同步执行；回调返回 awaitable 时自动转为任务。
"""
from __future__ import annotations

import asyncio
import inspect
import itertools
import json
from typing import Any, Callable, Optional

from .transport import BridgeConnection, ConnectionState, SemaEvent


class SemaBridgeException(Exception):
    """桥返回的 error 帧（≙ Java SemaBridgeException）。"""

    def __init__(self, action: str, message: str) -> None:
        super().__init__(f"[{action}] {message}")
        self.action = action
        self.message = message


class Registration:
    """事件订阅句柄（≙ Java Registration）。"""

    def __init__(self, unregister: Callable[[], None]) -> None:
        self._unregister = unregister

    def unregister(self) -> None:
        self._unregister()


class SemaBridgeClient:
    def __init__(self, connection: BridgeConnection) -> None:
        self._connection = connection
        self._cmd_seq = itertools.count(1)
        self._pending: dict[str, tuple[str, asyncio.Future]] = {}  # cmd_id -> (action, future)
        # (event, session_id) -> list[(listener, once)]
        self._listeners: dict[tuple[str, str], list[tuple[Callable, bool]]] = {}
        self._any_listeners: list[Callable[[SemaEvent], None]] = []
        connection.on_event(self._dispatch)
        connection.on_state_change(self._on_state_change)

    @property
    def connection(self) -> BridgeConnection:
        return self._connection

    # ── 指令 ─────────────────────────────────────────────────────────────

    async def call(self, action: str, payload_json: Optional[str] = None, session_id: str = "") -> str:
        """发送指令并等待 ack；error 帧抛 SemaBridgeException。返回 ack 的 data（JSON 字符串，可为空）。"""
        cmd_id = f"py-{next(self._cmd_seq)}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[cmd_id] = (action, fut)
        try:
            await self._connection.send(cmd_id, action, payload_json, session_id)
        except BaseException:
            self._pending.pop(cmd_id, None)
            raise
        return await fut

    # ── 事件 ─────────────────────────────────────────────────────────────

    def on(self, event: str, listener: Callable[[str, str], Any], session_id: str = "") -> Registration:
        """订阅事件；listener(data_json, session_id)。session_id="" 只收进程级帧。"""
        return self._register(event, session_id, listener, once=False)

    def once(self, event: str, listener: Callable[[str, str], Any], session_id: str = "") -> Registration:
        return self._register(event, session_id, listener, once=True)

    async def wait_for(self, event: str, session_id: str = "",
                       timeout: Optional[float] = None,
                       predicate: Optional[Callable[[str], bool]] = None) -> str:
        """等待事件出现（可选 predicate 对 data_json 过滤），返回 data JSON 字符串。"""
        fut: asyncio.Future = asyncio.get_running_loop().create_future()

        def hit(data_json: str, _sid: str) -> None:
            if fut.done():
                return
            if predicate is not None and not predicate(data_json):
                return
            fut.set_result(data_json)

        reg = self._register(event, session_id, hit, once=predicate is None)
        try:
            return await (asyncio.wait_for(fut, timeout) if timeout is not None else fut)
        finally:
            reg.unregister()

    def on_any(self, listener: Callable[[SemaEvent], None]) -> Registration:
        """原始帧订阅（哑转发宿主的逃生口）。"""
        self._any_listeners.append(listener)
        return Registration(lambda: self._any_listeners.remove(listener)
                            if listener in self._any_listeners else None)

    async def close(self) -> None:
        await self._connection.close()

    # ── 内部 ─────────────────────────────────────────────────────────────

    def _register(self, event: str, session_id: str, listener: Callable, once: bool) -> Registration:
        key = (event, session_id)
        entry = (listener, once)
        self._listeners.setdefault(key, []).append(entry)

        def unregister() -> None:
            bucket = self._listeners.get(key)
            if bucket and entry in bucket:
                bucket.remove(entry)

        return Registration(unregister)

    def _dispatch(self, evt: SemaEvent) -> None:
        for listener in list(self._any_listeners):
            self._safe(listener, evt)
        if evt.is_response:
            pending = self._pending.pop(evt.cmd_id, None)
            if pending is None:
                return
            action, fut = pending
            if fut.done():
                return
            if evt.event == "error":
                message = str(evt.data)
                try:
                    message = json.loads(evt.data).get("message", message)
                except (json.JSONDecodeError, AttributeError):
                    pass
                fut.set_exception(SemaBridgeException(action, message))
            else:
                fut.set_result(evt.data)
            return
        bucket = self._listeners.get((evt.event, evt.session_id))
        if not bucket:
            return
        for entry in list(bucket):
            listener, once = entry
            if once and entry in bucket:
                bucket.remove(entry)
            self._safe(listener, evt.data, evt.session_id)

    def _on_state_change(self, state: ConnectionState, err: Optional[BaseException]) -> None:
        if state in (ConnectionState.RECONNECTING, ConnectionState.CLOSED):
            # 断线：在途 call 立即失败（≙ Java 行为）
            pending, self._pending = self._pending, {}
            for action, fut in pending.values():
                if not fut.done():
                    fut.set_exception(SemaBridgeException(
                        action, f"连接中断（{state.value}）: {err or '流终止'}"))

    @staticmethod
    def _safe(listener: Callable, *args: Any) -> None:
        try:
            result = listener(*args)
            if inspect.isawaitable(result):
                asyncio.ensure_future(result)
        except Exception:
            pass

"""transport 层：gRPC 双向流连接（镜像 Java transport/BridgeConnection）。

行为规范（与 Java 逐条对应）：
- connect() 前后均可 send：就绪前指令入缓冲，channel 就绪后按序 flush；
- 断线自动重连：250ms 起指数退避、封顶 10s、默认无限次；
- 重连后原会话事件不自动续流，由上层重新 attach；
- 事件与状态回调都在本连接的读循环任务里同步执行（≙ Java 的 gRPC 分发线程），
  回调内不要 await 长任务、不要同步等待本连接的响应。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from enum import Enum
from typing import Awaitable, Callable, Optional

import grpc

from ._generated import sema_pb2, sema_pb2_grpc

DEFAULT_MAX_INBOUND_MESSAGE_SIZE = 64 * 1024 * 1024


class ConnectionState(Enum):
    CONNECTING = "CONNECTING"
    CONNECTED = "CONNECTED"
    RECONNECTING = "RECONNECTING"
    CLOSED = "CLOSED"


@dataclass(frozen=True)
class SemaEvent:
    """桥事件帧（≙ Java SemaEvent record）。data 为 JSON 字符串，薄客户端不解释。"""
    event: str
    data: str
    cmd_id: str
    session_id: str

    @property
    def is_response(self) -> bool:
        return bool(self.cmd_id)


class BridgeConnection:
    """gRPC 双向流连接。事件经 on_event 回调分发；send 在未就绪时自动缓冲。"""

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: Optional[int] = None,
        port_future: Optional[Awaitable[int]] = None,
        max_inbound_message_size: int = DEFAULT_MAX_INBOUND_MESSAGE_SIZE,
        reconnect_enabled: bool = True,
        reconnect_initial_backoff: float = 0.25,
        reconnect_max_backoff: float = 10.0,
        reconnect_max_attempts: Optional[int] = None,
    ) -> None:
        if port is None and port_future is None:
            raise ValueError("port 与 port_future 必须提供其一")
        self._host = host
        self._port = port
        self._port_future = port_future
        self._max_inbound = max_inbound_message_size
        self._reconnect_enabled = reconnect_enabled
        self._initial_backoff = reconnect_initial_backoff
        self._max_backoff = reconnect_max_backoff
        self._max_attempts = reconnect_max_attempts

        self._event_listeners: list[Callable[[SemaEvent], None]] = []
        self._state_listeners: list[Callable[[ConnectionState, Optional[BaseException]], None]] = []
        self._state = ConnectionState.CONNECTING
        self._buffer: list[sema_pb2.BridgeCommand] = []
        self._call: Optional[grpc.aio.StreamStreamCall] = None
        self._channel: Optional[grpc.aio.Channel] = None
        self._runner: Optional[asyncio.Task] = None
        self._closed = False

    # ── 订阅 ─────────────────────────────────────────────────────────────

    def on_event(self, listener: Callable[[SemaEvent], None]) -> None:
        self._event_listeners.append(listener)

    def on_state_change(self, listener: Callable[[ConnectionState, Optional[BaseException]], None]) -> None:
        self._state_listeners.append(listener)

    @property
    def state(self) -> ConnectionState:
        return self._state

    # ── 生命周期 ─────────────────────────────────────────────────────────

    def connect(self) -> None:
        """启动连接任务（幂等，非阻塞；≙ Java connect()）。"""
        if self._runner is None and not self._closed:
            self._runner = asyncio.get_running_loop().create_task(self._run(), name="sema-bridge-connection")

    async def send(self, cmd_id: str, action: str, payload: Optional[str], session_id: Optional[str]) -> None:
        """发送指令帧；未就绪时入缓冲（≙ Java send 的就绪前缓冲）。"""
        cmd = sema_pb2.BridgeCommand(
            id=cmd_id, action=action, payload=payload or "", session_id=session_id or "")
        if self._state is ConnectionState.CONNECTED and self._call is not None:
            await self._call.write(cmd)
        else:
            if self._closed:
                raise ConnectionError("连接已关闭")
            self._buffer.append(cmd)
            self.connect()

    async def close(self) -> None:
        self._closed = True
        self._set_state(ConnectionState.CLOSED, None)
        if self._runner is not None:
            self._runner.cancel()
            try:
                await self._runner
            except (asyncio.CancelledError, Exception):
                pass
            self._runner = None
        await self._teardown_channel()

    async def __aenter__(self) -> "BridgeConnection":
        self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    # ── 内部：连接主循环 ─────────────────────────────────────────────────

    async def _run(self) -> None:
        if self._port is None:
            self._port = await self._port_future  # sidecar 端口握手
        attempt = 0
        while not self._closed:
            err: Optional[BaseException] = None
            try:
                self._channel = grpc.aio.insecure_channel(
                    f"{self._host}:{self._port}",
                    options=[("grpc.max_receive_message_length", self._max_inbound)],
                )
                stub = sema_pb2_grpc.SemaBridgeStub(self._channel)
                self._call = stub.Connect()
                await asyncio.wait_for(self._channel.channel_ready(), timeout=10)
                self._set_state(ConnectionState.CONNECTED, None)
                attempt = 0
                # 按序 flush 就绪前缓冲
                pending, self._buffer = self._buffer, []
                for cmd in pending:
                    await self._call.write(cmd)
                async for msg in self._call:
                    evt = SemaEvent(event=msg.event, data=msg.data,
                                    cmd_id=msg.cmd_id, session_id=msg.session_id)
                    for listener in list(self._event_listeners):
                        listener(evt)
                # 流正常终止也按断线处理
            except asyncio.CancelledError:
                raise
            except BaseException as e:  # noqa: BLE001 —— 断线重连的兜底边界
                err = e
            finally:
                await self._teardown_channel()
            if self._closed:
                break
            attempt += 1
            if not self._reconnect_enabled or (self._max_attempts is not None and attempt > self._max_attempts):
                self._set_state(ConnectionState.CLOSED, err)
                self._closed = True
                break
            self._set_state(ConnectionState.RECONNECTING, err)
            backoff = min(self._initial_backoff * (2 ** (attempt - 1)), self._max_backoff)
            await asyncio.sleep(backoff)

    async def _teardown_channel(self) -> None:
        call, self._call = self._call, None
        channel, self._channel = self._channel, None
        if call is not None:
            try:
                call.cancel()
            except Exception:
                pass
        if channel is not None:
            try:
                await channel.close()
            except Exception:
                pass

    def _set_state(self, state: ConnectionState, err: Optional[BaseException]) -> None:
        if self._state is state:
            return
        self._state = state
        for listener in list(self._state_listeners):
            try:
                listener(state, err)
            except Exception:
                pass

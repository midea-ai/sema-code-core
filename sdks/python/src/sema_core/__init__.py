"""sema-sdk：sema-core 的 Python SDK（gRPC 桥薄客户端，asyncio-first）。

    from sema_sdk import SemaCore

    core = await SemaCore.start({"workingDir": project_dir})
    session = await core.create_session()
    session.on("message:text:chunk", lambda d: print(d["delta"], end=""))
    await session.process_user_input("你好")
    await core.close()
"""
from . import events as SemaEvents
from .api import SemaCore, SemaSession
from .constants import MAIN_AGENT_ID, PROTOCOL_VERSION
from .protocol import Registration, SemaBridgeClient, SemaBridgeException
from .runtime import NodeProvider, SidecarManager, system_node_provider
from .transport import BridgeConnection, ConnectionState, SemaEvent

__all__ = [
    "SemaCore", "SemaSession", "SemaEvents",
    "MAIN_AGENT_ID", "PROTOCOL_VERSION",
    "SemaBridgeClient", "SemaBridgeException", "Registration",
    "BridgeConnection", "ConnectionState", "SemaEvent",
    "SidecarManager", "NodeProvider", "system_node_provider",
]

"""sema-core：sema-core 的 Python SDK（gRPC 桥薄客户端，asyncio-first）。

导入布局对齐 Node（`pip install sema-core` → `import sema_core`，连字符→下划线为 Python 约束）：

    from sema_core import SemaCore, SemaSession          # ≙ from 'sema-core'
    from sema_core.types import ModelConfig, CronTask     # ≙ from 'sema-core/types'
    from sema_core.event import TextChunkData, Usage      # ≙ from 'sema-core/event'

用法：

    core = await SemaCore.start({"workingDir": project_dir})
    session = await core.create_session()
    session.on("message:text:chunk", lambda d: print(d["delta"], end=""))
    await session.process_user_input("你好")
    await core.close()
"""
from . import event, types
from . import events as SemaEvents
from .api import SemaCore, SemaSession
from .constants import MAIN_AGENT_ID, PROTOCOL_VERSION
from .protocol import Registration, SemaBridgeClient, SemaBridgeException
from .runtime import NodeProvider, SidecarManager, system_node_provider
from .transport import BridgeConnection, ConnectionState, SemaEvent

# 注：Fork* / InputImageAttachment 归 `sema_core.types` 入口（不再从主包再导出）。

__all__ = [
    # 主 API
    "SemaCore", "SemaSession",
    # 子模块（≙ 'sema-core/types'、'sema-core/event'）与事件名常量
    "types", "event", "SemaEvents",
    # 常量
    "MAIN_AGENT_ID", "PROTOCOL_VERSION",
    # 协议 / 传输 / 运行时逃生口
    "SemaBridgeClient", "SemaBridgeException", "Registration",
    "BridgeConnection", "ConnectionState", "SemaEvent",
    "SidecarManager", "NodeProvider", "system_node_provider",
]

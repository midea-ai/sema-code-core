"""契约冒烟（三期，与 Java ContractSmokeTest 同场景）：起真实 node 桥，
走「init 握手 → create_session → 事件重放 → list_sessions → close_session」闭环。
不依赖模型配置（不发 process_user_input），装了 node 即可跑：

    .venv/bin/python tests/contract_smoke.py
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from sema_sdk import SemaCore, SemaEvents  # noqa: E402


async def main() -> int:
    with tempfile.TemporaryDirectory() as working_dir:
        # start 内含协议版本握手：版本漂移在这里就会抛 SemaBridgeException
        core = await SemaCore.start({"workingDir": working_dir, "logLevel": "none"})
        try:
            session = await asyncio.wait_for(core.create_session(), timeout=30)
            assert session.session_id, "sessionId 不能为空"

            # 创建期事件缓存重放：晚订阅也必须等得到 session:ready
            ready = await session.wait_for(SemaEvents.SESSION_READY, timeout=15)
            assert ready is not None

            sessions = await asyncio.wait_for(core.list_sessions(), timeout=10)
            assert session.session_id in str(sessions), f"listSessions 应包含新会话: {sessions}"

            await asyncio.wait_for(core.close_session(session.session_id), timeout=10)
            print(f"✓ 契约冒烟通过（session={session.session_id}）")
            return 0
        finally:
            await core.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

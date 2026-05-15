from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class BridgeEvent:
    """Node.js → 宿主 事件帧"""

    event: str = ""
    data: Any = None
    cmd_id: Optional[str] = None
    error: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict) -> "BridgeEvent":
        return cls(
            event=d.get("event", ""),
            data=d.get("data"),
            cmd_id=d.get("cmdId"),
            error=d.get("error"),
        )

import json
import uuid
from dataclasses import dataclass, field
from typing import Any


@dataclass
class BridgeCommand:
    """宿主 → Node.js 指令帧"""

    action: str
    payload: Any = None
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])

    def to_json(self) -> str:
        d: dict = {"id": self.id, "action": self.action}
        if self.payload is not None:
            d["payload"] = self.payload
        return json.dumps(d)

"""把桥的自包含产物内嵌进包数据 src/sema_core/_sidecar/（与 Java jar 内嵌 sema-sidecar/ 同构）。

「SDK 版本 = 桥版本 = core 版本」一次锁定。构建产物不入 git，安装/发布前执行：
    cd ../shared/bridge && npm run build && cd ../../python && python scripts/embed_sidecar.py
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE_DIST = ROOT.parent / "shared" / "bridge" / "dist"
PROTO_SRC = ROOT.parent / "shared" / "proto" / "sema.proto"
SIDECAR_DIR = ROOT / "src" / "sema_core" / "_sidecar"


def main() -> int:
    server_js = BRIDGE_DIST / "server.js"
    if not server_js.is_file():
        print(f"缺少 sidecar 产物 {server_js}：先执行 cd ../shared/bridge && npm install && npm run build", file=sys.stderr)
        return 1
    (SIDECAR_DIR / "proto").mkdir(parents=True, exist_ok=True)
    shutil.copy2(server_js, SIDECAR_DIR / "server.js")
    shutil.copy2(PROTO_SRC, SIDECAR_DIR / "proto" / "sema.proto")
    print(f"embedded: {SIDECAR_DIR}/server.js (+ proto/sema.proto)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

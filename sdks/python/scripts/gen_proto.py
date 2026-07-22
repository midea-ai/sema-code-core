"""从唯一协议源 ../shared/proto/sema.proto 生成 gRPC stub 到 src/sema_core/_generated/。

生成物提交进仓（pip 安装不依赖 protoc）；协议变更后重跑本脚本。
用法：.venv/bin/python scripts/gen_proto.py（需 dev 依赖 grpcio-tools）
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from grpc_tools import protoc

ROOT = Path(__file__).resolve().parent.parent
PROTO_DIR = ROOT.parent / "shared" / "proto"
OUT_DIR = ROOT / "src" / "sema_core" / "_generated"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "__init__.py").write_text("", encoding="utf-8")
    rc = protoc.main([
        "protoc",
        f"--proto_path={PROTO_DIR}",
        f"--python_out={OUT_DIR}",
        f"--grpc_python_out={OUT_DIR}",
        str(PROTO_DIR / "sema.proto"),
    ])
    if rc != 0:
        return rc
    # protoc 生成的是顶层绝对导入（import sema_pb2），改为包内相对导入
    grpc_file = OUT_DIR / "sema_pb2_grpc.py"
    text = grpc_file.read_text(encoding="utf-8")
    text = re.sub(r"^import sema_pb2 as", "from . import sema_pb2 as", text, flags=re.M)
    grpc_file.write_text(text, encoding="utf-8")
    print(f"generated: {OUT_DIR}/sema_pb2.py, sema_pb2_grpc.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# Sema Python SDK

sema-core 的 Python SDK（模块 `sema_core`）：gRPC 桥（`../shared/bridge/`）的薄客户端，asyncio-first，Python 3.10+。core 只有 Node 一份实现，SDK 负责连接管理、指令/事件、sidecar 托管，不重写任何 core 逻辑。sidecar 内嵌在包里自动释放拉起，用户 `pip install` 后开箱即用（本机需 node ≥18）。使用示例见 `example/python-demo`。

## 目录结构

```
sdks/python/
├── pyproject.toml            # 包元数据；依赖 grpcio/protobuf；dev 依赖 grpcio-tools
├── scripts/
│   ├── gen_proto.py          # ../shared/proto/sema.proto → _generated/（协议变更后重跑）
│   └── embed_sidecar.py      # ../shared/bridge/dist → _sidecar/（打包前执行，≙ Java jar 内嵌）
├── src/sema_core/
│   ├── __init__.py           # 导出全部公共 API
│   ├── api.py                # SemaCore / SemaSession（镜像 API，68 action 全量 1:1）
│   ├── types.py              # 配置/参数/返回 DTO（TypedDict，≙ 'sema-core/types'）
│   ├── event.py              # 事件数据 DTO（TypedDict，≙ 'sema-core/event'）
│   ├── constants.py          # MAIN_AGENT_ID / PROTOCOL_VERSION
│   ├── transport.py          # BridgeConnection / SemaEvent / ConnectionState
│   ├── protocol.py           # SemaBridgeClient / SemaBridgeException / Registration
│   ├── runtime.py            # SidecarManager / NodeProvider
│   ├── _generated/           # sema_pb2 / sema_pb2_grpc（提交进仓）
│   └── _sidecar/             # 桥产物内嵌副本（构建产物，不入 git）
└── tests/contract_smoke.py   # 契约冒烟（起真实桥，不依赖模型配置）
```

## 构建与打包

从仓库根目录开始，整段粘贴即可：

```bash
# ① 构建桥产物（sidecar 以此为准）
cd sdks/shared/bridge && npm install && npm run build

# ② 本目录建 venv 并装构建工具
cd ../../python
python3 -m venv .venv
source .venv/bin/activate
pip install build twine

# ③ 内嵌 sidecar → 清旧产物 → 打包
python scripts/embed_sidecar.py
rm -rf dist build src/*.egg-info
python -m build
```

成功后 dist/ 下应有 `sema_core-<版本号>-py3-none-any.whl` 和 `sema_core-<版本号>.tar.gz`（版本号以 `pyproject.toml` 为准）。

## 发布

```bash
twine upload dist/*                          # 确认无误后正式发布
```



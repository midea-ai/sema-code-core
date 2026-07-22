"""runtime 层：sidecar 托管（镜像 Java runtime/SidecarManager）。

- 拉起 Node 桥进程，SEMA_BRIDGE_PORT=0 由系统分配端口，stdout 解析
  `SEMA_BRIDGE_PORT_ACTUAL=<port>` 完成端口握手；
- sidecar 目录解析顺序：显式参数 → 环境变量 SEMA_SIDECAR_DIR → 包内捆绑
  （_sidecar/，释放到 ~/.sema/python-sdk-sidecar，与 Java 的 jar 内嵌同构）；
- 注入 SEMA_BRIDGE_PARENT_OWNED=1：生命周期归本 manager（close 发 SIGTERM），
  终端宿主的 Ctrl-C 广播 SIGINT 时桥忽略，保住「第一次 Ctrl-C 只中断会话」语义；
- Node 供应按设计稿只做本地探测（SEMA_NODE_PATH → PATH 里 ≥18 的 node → 常见
  绝对路径），下载/缓存由宿主注入 node_provider 解决。
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
from importlib import resources
from pathlib import Path
from typing import Any, Callable, Optional

from .protocol import SemaBridgeClient
from .transport import BridgeConnection

_PORT_PATTERN = re.compile(r"SEMA_BRIDGE_PORT_ACTUAL=(\d+)")
_SERVER_JS_CANDIDATES = ("server.js", "dist/server.js", "dist/src/server.js")
_COMMON_NODE_PATHS = (
    "/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node",
    os.path.expanduser("~/.sema/node/20.18.0"),
)

NodeProvider = Callable[[], str]
"""返回可用 node 可执行文件路径；宿主可注入自带下载/缓存逻辑的实现。"""


def system_node_provider() -> str:
    """本地探测：SEMA_NODE_PATH → PATH 里 ≥18 的 node → 常见绝对路径。"""
    explicit = os.environ.get("SEMA_NODE_PATH")
    if explicit and Path(explicit).is_file():
        return explicit
    candidates: list[str] = []
    found = shutil.which("node", path=_login_shell_path())
    if found:
        candidates.append(found)
    for p in _COMMON_NODE_PATHS:
        path = Path(p)
        if path.is_file():
            candidates.append(str(path))
        elif path.is_dir():  # ~/.sema/node 缓存布局：<ver>/<triple>/bin/node
            candidates.extend(str(f) for f in path.glob("*/bin/node"))
    for node in candidates:
        if _node_major(node) >= 18:
            return node
    raise FileNotFoundError(
        "未找到 node ≥18：安装 node、设置 SEMA_NODE_PATH，或注入自定义 node_provider")


def _node_major(node: str) -> int:
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10)
        return int(out.stdout.strip().lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0


_login_path_cache: Optional[str] = None


def _login_shell_path() -> str:
    """登录 shell 的真实 PATH（GUI 场景下 PATH 不全；≙ Java Provisioner.loginShellPath）。"""
    global _login_path_cache
    if _login_path_cache is None:
        path = os.environ.get("PATH", "")
        if sys.platform != "win32":
            shell = os.environ.get("SHELL", "/bin/zsh")
            try:
                out = subprocess.run([shell, "-ilc", "echo -n \"$PATH\""],
                                     capture_output=True, text=True, timeout=10)
                if out.returncode == 0 and out.stdout.strip():
                    path = out.stdout.strip().splitlines()[-1]
            except (OSError, subprocess.TimeoutExpired):
                pass
        _login_path_cache = path
    return _login_path_cache


class SidecarManager:
    """一个 manager = 一个 sidecar 进程；start 幂等，close 终止进程（3s 宽限后强杀）。"""

    def __init__(
        self,
        *,
        sidecar_dir: Optional[str | Path] = None,
        working_dir: Optional[str | Path] = None,
        env: Optional[dict[str, str]] = None,
        node_provider: NodeProvider = system_node_provider,
        log_consumer: Optional[Callable[[str], None]] = None,
        on_exit: Optional[Callable[[int], None]] = None,
    ) -> None:
        self._sidecar_dir = Path(sidecar_dir) if sidecar_dir else None
        self._working_dir = Path(working_dir) if working_dir else Path.cwd()
        self._extra_env = dict(env or {})
        self._node_provider = node_provider
        self._log_consumer = log_consumer
        self._on_exit = on_exit
        self._process: Optional[asyncio.subprocess.Process] = None
        self._port_future: Optional[asyncio.Future[int]] = None
        self._closed = False

    # ── 生命周期 ─────────────────────────────────────────────────────────

    def start(self) -> "asyncio.Future[int]":
        """异步启动（幂等），返回端口 future。"""
        if self._port_future is None:
            loop = asyncio.get_running_loop()
            self._port_future = loop.create_future()
            loop.create_task(self._boot(), name="sema-sidecar-boot")
        return self._port_future

    async def close(self) -> None:
        self._closed = True
        process, self._process = self._process, None
        if process is not None and process.returncode is None:
            process.terminate()  # SIGTERM：桥的 SIGTERM 处理器做 dispose
            try:
                await asyncio.wait_for(process.wait(), timeout=3)
            except asyncio.TimeoutError:
                process.kill()

    async def __aenter__(self) -> "SidecarManager":
        self.start()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    # ── 连接工厂 ─────────────────────────────────────────────────────────

    def new_connection(self) -> BridgeConnection:
        """预接本 sidecar 端口的连接（隐式触发 start）。"""
        conn = BridgeConnection(port_future=self.start())
        conn.connect()
        return conn

    def new_client(self) -> SemaBridgeClient:
        return SemaBridgeClient(self.new_connection())

    async def new_core(self, config: Optional[dict[str, Any]] = None):
        from .api import SemaCore  # 延迟导入避免环
        return await SemaCore.attach(self.new_client(), config)

    # ── 内部 ─────────────────────────────────────────────────────────────

    async def _boot(self) -> None:
        try:
            server_js = self._resolve_server_js()
            node = self._node_provider()
            env = dict(os.environ)
            env.setdefault("SEMA_BRIDGE_PORT", "0")
            env["SEMA_WORKING_DIR"] = str(self._working_dir)
            env["SEMA_BRIDGE_PARENT_OWNED"] = "1"
            env.update(self._extra_env)
            # 子进程 PATH：node 所在目录前置 + 登录 shell PATH（sema-core 再 spawn node/rg 时按 PATH 查找）
            env["PATH"] = os.pathsep.join([str(Path(node).parent), _login_shell_path()])

            self._process = await asyncio.create_subprocess_exec(
                node, str(server_js),
                cwd=str(server_js.parent),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            asyncio.get_running_loop().create_task(self._pump_stdout(), name="sema-sidecar-stdout")
        except BaseException as e:
            if self._port_future is not None and not self._port_future.done():
                self._port_future.set_exception(e)

    async def _pump_stdout(self) -> None:
        process = self._process
        assert process is not None and process.stdout is not None
        async for raw in process.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip()
            match = _PORT_PATTERN.search(line)
            if match and self._port_future is not None and not self._port_future.done():
                self._port_future.set_result(int(match.group(1)))
            if self._log_consumer is not None:
                self._log_consumer(line)
        code = await process.wait()
        if self._port_future is not None and not self._port_future.done():
            self._port_future.set_exception(
                RuntimeError(f"sidecar 提前退出 code={code}（先确认 sdks/bridge 已 npm run build）"))
        if self._on_exit is not None and not self._closed:
            self._on_exit(code)

    def _resolve_server_js(self) -> Path:
        directories: list[Path] = []
        if self._sidecar_dir is not None:
            directories.append(self._sidecar_dir)
        env_dir = os.environ.get("SEMA_SIDECAR_DIR")
        if env_dir:
            directories.append(Path(env_dir))
        bundled = self._extract_bundled_sidecar()
        if bundled is not None:
            directories.append(bundled)
        for directory in directories:
            for candidate in _SERVER_JS_CANDIDATES:
                f = directory / candidate
                if f.is_file():
                    return f
        raise FileNotFoundError(
            "未找到 sidecar：请通过 sidecar_dir 参数或环境变量 SEMA_SIDECAR_DIR 指向含 server.js 的目录，"
            "或安装内嵌 sidecar 的 sema-sdk 发行包（构建前先执行 scripts/embed_sidecar.py）")

    @staticmethod
    def _extract_bundled_sidecar() -> Optional[Path]:
        """包内捆绑产物释放到 ~/.sema/python-sdk-sidecar（≙ Java extractBundledSidecar）。"""
        pkg = resources.files("sema_sdk")
        server = pkg / "_sidecar" / "server.js"
        if not server.is_file():
            return None
        target = Path.home() / ".sema" / "python-sdk-sidecar"
        (target / "proto").mkdir(parents=True, exist_ok=True)
        (target / "server.js").write_bytes(server.read_bytes())
        proto = pkg / "_sidecar" / "proto" / "sema.proto"
        if proto.is_file():
            (target / "proto" / "sema.proto").write_bytes(proto.read_bytes())
        return target

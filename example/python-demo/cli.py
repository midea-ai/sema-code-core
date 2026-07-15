"""入口 1：交互式 CLI

pip install sema-core

用法：
    python cli.py /path/to/project           # 指定项目目录（必填），新建会话
    python cli.py /path/to/project <会话id>   # 指定目录 + 加载历史会话

模型自动读取 ~/.sema/model.conf（见 README），代码里无需配置模型。
"""
from __future__ import annotations

import asyncio
import codecs
import os
import signal
import sys
import termios
import tty
from dataclasses import dataclass
from pathlib import Path

from sema_sdk import MAIN_AGENT_ID, SemaCore, SemaEvents, SemaSession

MAX_LOG_LEN = 200

gray = lambda s: f"\x1b[90m{s}\x1b[0m"   # noqa: E731
blue = lambda s: f"\x1b[34m{s}\x1b[0m"   # noqa: E731
green = lambda s: f"\x1b[32m{s}\x1b[0m"  # noqa: E731


@dataclass
class UiAskInput:
    pass


@dataclass
class UiPermission:
    tool_id: str
    tool_name: str


@dataclass
class UiError:
    message: str


@dataclass
class UiQuit:
    pass


class Cli:
    def __init__(self, working_dir: str, resume_session_id: str | None) -> None:
        self.working_dir = working_dir
        self.resume_session_id = resume_session_id
        self.session: SemaSession | None = None
        self.ui_queue: asyncio.Queue = asyncio.Queue()
        self.line_queue: asyncio.Queue = asyncio.Queue()  # str | None(EOF)
        self.ask_pending = False        # ≙ cli.ts 的 awaitingInput
        self.interrupt_count = 0        # 第一次中断会话，第二次强制退出
        self.sub_agent_depth = 0
        self.saved_tty: list | None = None
        self.is_tty = sys.stdin.isatty()

    # ── 中断处理（≙ cli.ts 的 SIGINT / esc 两个入口） ─────────────────────

    def on_sigint(self) -> None:
        print("\n⚠️  中断会话...", flush=True)
        self.interrupt_or_exit()

    def interrupt_or_exit(self) -> None:
        self.interrupt_count += 1
        if self.session is not None and self.interrupt_count == 1:
            asyncio.ensure_future(self.session.interrupt())  # fire-and-forget
        else:
            # 第二次：解锁对话循环（无论卡在 ui_queue 还是 line_queue），
            # 由 run() 的 finally 恢复终端并级联关闭 sidecar（≙ Java 的 shutdown hook）
            self.line_queue.put_nowait(None)
            self.ui_queue.put_nowait(UiQuit())

    def setup_tty(self) -> None:
        """esc 检测需 cbreak（非规范 + 关回显，保留 ISIG；≙ setRawMode）。"""
        if not self.is_tty:
            return
        fd = sys.stdin.fileno()
        self.saved_tty = termios.tcgetattr(fd)
        # TCSANOW：默认的 TCSAFLUSH 会丢弃已缓冲的输入（启动期用户抢先打的字）
        tty.setcbreak(fd, termios.TCSANOW)
        attrs = termios.tcgetattr(fd)
        attrs[3] &= ~termios.ECHO  # setcbreak 不关回显，自行关掉后由 reader 统一回显
        termios.tcsetattr(fd, termios.TCSANOW, attrs)

    def restore_tty(self) -> None:
        if self.saved_tty is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, self.saved_tty)

    # ── stdin 读取（loop.add_reader，逐块读；esc 即时生效） ────────────────

    def start_stdin_reader(self, loop: asyncio.AbstractEventLoop) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        buf: list[str] = []
        fd = sys.stdin.fileno()

        def on_readable() -> None:
            chunk = os.read(fd, 1024)
            if not chunk:  # EOF（管道输入耗尽）
                loop.remove_reader(fd)
                self.line_queue.put_nowait(None)
                return
            # esc 单独按键才算中断；方向键等 CSI 序列（esc 后紧跟字节）整段丢弃
            if self.is_tty and chunk.startswith(b"\x1b"):
                if chunk == b"\x1b":
                    self.interrupt_or_exit()
                return
            for ch in decoder.decode(chunk):
                if ch in ("\r", "\n"):
                    if self.is_tty:
                        print()
                    self.line_queue.put_nowait("".join(buf))
                    buf.clear()
                elif ch in ("\x7f", "\b"):
                    if buf:
                        last = buf.pop()
                        if self.is_tty:  # CJK 等宽字符占两格
                            sys.stdout.write("\b\b  \b\b" if ord(last) > 0xFF else "\b \b")
                            sys.stdout.flush()
                elif ch >= " ":
                    buf.append(ch)
                    if self.is_tty:
                        sys.stdout.write(ch)
                        sys.stdout.flush()

        loop.add_reader(fd, on_readable)

    async def next_line(self) -> str | None:
        return await self.line_queue.get()

    # ── 事件订阅（对应 cli.ts 各节） ──────────────────────────────────────

    def subscribe(self, session: SemaSession) -> None:
        def truncate(s: str) -> str:
            return s if len(s) <= MAX_LOG_LEN else f"{s[:MAX_LOG_LEN]}...({len(s) - MAX_LOG_LEN} more)"

        # 工具/任务事件：仅打印标题（截断超长内容）
        for e in (SemaEvents.TOOL_EXECUTION_COMPLETE, SemaEvents.TOOL_EXECUTION_ERROR,
                  SemaEvents.TOOL_PERMISSION_REQUEST, SemaEvents.TASK_AGENT_START,
                  SemaEvents.TASK_AGENT_END, SemaEvents.TODOS_UPDATE,
                  SemaEvents.SESSION_INTERRUPTED):
            session.on(e, lambda d, e=e: print(gray(f"{e}|{truncate(str(d))}")))

        # 子代理深度跟踪：message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断
        session.on(SemaEvents.TASK_AGENT_START, lambda d: self._bump_depth(1))
        session.on(SemaEvents.TASK_AGENT_END, lambda d: self._bump_depth(-1))

        # 流式输出：仅主代理，避免子代理文本混入主输出
        def on_chunk(d) -> None:
            delta = (d or {}).get("delta")
            if self.sub_agent_depth > 0 or not delta:
                return
            sys.stdout.write(delta)
            sys.stdout.flush()

        session.on(SemaEvents.MESSAGE_TEXT_CHUNK, on_chunk)
        session.on(SemaEvents.MESSAGE_COMPLETE, lambda d: (
            print() if (d or {}).get("agentId") in (None, MAIN_AGENT_ID) else None))

        # 权限交互：入队交对话循环读 y/n
        session.on(SemaEvents.TOOL_PERMISSION_REQUEST, lambda d: self.ui_queue.put_nowait(
            UiPermission((d or {}).get("toolId", ""), (d or {}).get("toolName", ""))))

        # 恢复运行后重置中断计数；以主代理回到 idle 作为一轮结束信号
        def on_state(d) -> None:
            state = (d or {}).get("state")
            if state == "processing":
                self.interrupt_count = 0
            if state == "idle":
                self.enqueue_ask()

        session.on(SemaEvents.STATE_UPDATE, on_state)
        session.on(SemaEvents.SESSION_INTERRUPTED, lambda d: self.enqueue_ask())
        # 会话初始即 idle 不会触发 state:update，靠 session:ready 弹首条输入（SDK 缓存重放）
        session.once(SemaEvents.SESSION_READY, lambda d: self.enqueue_ask())
        session.once(SemaEvents.SESSION_ERROR, lambda d: self.ui_queue.put_nowait(
            UiError((d or {}).get("message") or str(d))))

    def _bump_depth(self, delta: int) -> None:
        self.sub_agent_depth = max(0, self.sub_agent_depth + delta)

    def enqueue_ask(self) -> None:
        """ready/idle/interrupted 都可能触发询问，ask_pending 防重复弹出输入。"""
        if not self.ask_pending:
            self.ask_pending = True
            self.ui_queue.put_nowait(UiAskInput())

    # ── 对话循环 ─────────────────────────────────────────────────────────

    async def conversation_loop(self, session: SemaSession) -> None:
        while True:
            ev = await self.ui_queue.get()
            if isinstance(ev, UiQuit):
                return
            if isinstance(ev, UiError):
                raise RuntimeError(ev.message)
            if isinstance(ev, UiPermission):
                sys.stdout.write(blue("👤 权限响应 (y=agree / n=refuse): "))
                sys.stdout.flush()
                answer = await self.next_line()
                if answer is None:
                    return
                selected = "refuse" if answer.strip().lower() == "n" else "agree"
                await session.respond_to_tool_permission(
                    {"toolId": ev.tool_id, "toolName": ev.tool_name, "selected": selected})
                continue
            # UiAskInput
            sys.stdout.write(blue("\n👤 消息 (esc中断): "))
            sys.stdout.flush()
            line = await self.next_line()
            self.ask_pending = False  # 读到输入后才复位，镜像 cli.ts 的 awaitingInput 时序
            if line is None:
                return  # EOF 视同退出
            text = line.strip()
            if text in ("exit", "quit"):
                return
            if not text:
                self.enqueue_ask()
                continue
            sys.stdout.write("\n" + green("🤖 AI: "))
            sys.stdout.flush()
            self.interrupt_count = 0  # ≙ cli.ts askAndSend 发送前清零
            await session.process_user_input(text)

    async def run(self) -> None:
        # ≙ Node: new SemaCore({...})，配置项一字不差。sidecar 内嵌在 SDK 包里自动释放拉起。
        core = await SemaCore.start({
            "workingDir": self.working_dir,
            "logLevel": "none",
            "thinking": True,
            "disableTopicDetection": True,
            "disableBackgroundTasks": True,
            "disabledTools": ["ask_form", "plan_to_agent"],
        })
        try:
            self.session = await core.create_session(
                {"sessionId": self.resume_session_id} if self.resume_session_id else {})
            print(green(f"会话id: {self.session.session_id}")
                  + gray(" (已加载历史会话)" if self.resume_session_id else " (新建会话)"))

            loop = asyncio.get_running_loop()
            loop.add_signal_handler(signal.SIGINT, self.on_sigint)
            self.setup_tty()
            self.start_stdin_reader(loop)

            self.subscribe(self.session)
            await self.conversation_loop(self.session)

            print("\n=== 会话结束 ===")
            try:
                await asyncio.wait_for(core.close_session(self.session.session_id), timeout=5)
            except Exception:
                pass  # 退出路径尽力而为
        finally:
            self.restore_tty()
            await core.close()


def main() -> None:
    positional = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not positional:
        print("用法: python cli.py <项目目录> [会话id]", file=sys.stderr)
        sys.exit(1)
    working_dir, resume = positional[0], positional[1] if len(positional) > 1 else None
    if not Path(working_dir).is_dir():
        print(f"项目目录不存在或不是目录: {working_dir}", file=sys.stderr)
        sys.exit(1)
    try:
        asyncio.run(Cli(working_dir, resume).run())
    except RuntimeError as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

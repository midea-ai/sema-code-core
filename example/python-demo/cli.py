"""入口 1：交互式 CLI

pip install sema-core

用法：
    python cli.py /path/to/project           # 指定项目目录（必填），新建会话
    python cli.py /path/to/project <会话id>   # 指定目录 + 加载历史会话

模型自动读取 ~/.sema/model.conf（见 README），代码里无需配置模型。

与 TS 版 cli.ts 的差异：不支持 esc 单键中断，统一用 Ctrl+C：第一次中断会话，
第二次退出。行编辑（回显/退格）由 readline 接管，在后台线程跑 input()。
"""
from __future__ import annotations

import asyncio
import queue
import signal
import sys
import termios
import threading
from pathlib import Path

from sema_core import MAIN_AGENT_ID, SemaCore, SemaEvents, SemaSession

MAX_LOG_LEN = 200

gray = lambda s: f"\x1b[90m{s}\x1b[0m"   # noqa: E731
green = lambda s: f"\x1b[32m{s}\x1b[0m"  # noqa: E731


class Cli:
    def __init__(self, working_dir: str, resume_session_id: str | None) -> None:
        self.working_dir = working_dir
        self.resume_session_id = resume_session_id
        self.session: SemaSession | None = None
        # 事件回调是同步的，不能在回调里等用户输入；权限询问/消息询问都会抢 stdin，
        # 统一入队由对话循环串行消费。消息形如：
        # ("ask",) | ("perm", tool_id, tool_name) | ("error", msg) | ("quit",)
        self.ui_queue: asyncio.Queue = asyncio.Queue()
        self.line_queue: asyncio.Queue = asyncio.Queue()  # str | None(EOF)
        self.ask_pending = False        # ≙ cli.ts 的 awaitingInput
        self.interrupt_count = 0        # 第一次中断会话，第二次强制退出
        self.sub_agent_depth = 0

    # ── Ctrl+C 中断（≙ cli.ts 的 SIGINT 分支） ───────────────────────────

    def on_sigint(self) -> None:
        print("\n⚠️  中断会话...", flush=True)
        self.interrupt_count += 1
        if self.session is not None and self.interrupt_count == 1:
            asyncio.ensure_future(self.session.interrupt())  # fire-and-forget
        else:
            # 第二次：解锁对话循环（无论卡在 ui_queue 还是 line_queue），
            # 由 run() 的 finally 级联关闭 sidecar（≙ Java 的 shutdown hook）
            self.line_queue.put_nowait(None)
            self.ui_queue.put_nowait(("quit",))

    # ── stdin 读取：后台线程跑 input()，readline 负责行编辑（宽字符退格正确） ──

    def start_stdin_reader(self, loop: asyncio.AbstractEventLoop) -> None:
        self.prompt_queue: queue.Queue = queue.Queue()  # 收到提示符字符串即唤起一次 input()

        def reader() -> None:
            while True:
                prompt = self.prompt_queue.get()
                try:
                    line = input(prompt)
                except EOFError:  # 管道输入耗尽 / Ctrl+D
                    loop.call_soon_threadsafe(self.line_queue.put_nowait, None)
                    return
                loop.call_soon_threadsafe(self.line_queue.put_nowait, line)

        # daemon：退出路径（二次 Ctrl+C / 会话错误）上 input() 可能仍阻塞在 stdin，不能等它结束
        threading.Thread(target=reader, daemon=True, name="stdin-reader").start()

    async def next_line(self, prompt: str) -> str | None:
        self.prompt_queue.put(prompt)
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
            ("perm", (d or {}).get("toolId", ""), (d or {}).get("toolName", ""))))

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
            ("error", (d or {}).get("message") or str(d))))

    def _bump_depth(self, delta: int) -> None:
        self.sub_agent_depth = max(0, self.sub_agent_depth + delta)

    def enqueue_ask(self) -> None:
        """ready/idle/interrupted 都可能触发询问，ask_pending 防重复弹出输入。"""
        if not self.ask_pending:
            self.ask_pending = True
            self.ui_queue.put_nowait(("ask",))

    # ── 对话循环 ─────────────────────────────────────────────────────────

    async def conversation_loop(self, session: SemaSession) -> None:
        while True:
            ev = await self.ui_queue.get()
            kind = ev[0]
            if kind == "quit":
                return
            if kind == "error":
                raise RuntimeError(ev[1])
            if kind == "perm":
                _, tool_id, tool_name = ev
                # 提示符必须交给 input()/readline 打印才能正确重绘；不能带 ANSI 色
                # （readline 会把转义序列算进列宽，编辑时错位）
                answer = await self.next_line("👤 权限响应 (y=agree / n=refuse): ")
                if answer is None:
                    return
                selected = "refuse" if answer.strip().lower() == "n" else "agree"
                await session.respond_to_tool_permission(
                    {"toolId": tool_id, "toolName": tool_name, "selected": selected})
                continue
            # ("ask",)
            line = await self.next_line("\n👤 消息 (Ctrl+C中断): ")
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
        try:
            tty_attrs = termios.tcgetattr(sys.stdin.fileno())
        except Exception:
            tty_attrs = None  # stdin 非终端（管道输入）
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
            self.start_stdin_reader(loop)

            self.subscribe(self.session)
            await self.conversation_loop(self.session)

            print("\n=== 会话结束 ===")
            try:
                await asyncio.wait_for(core.close_session(self.session.session_id), timeout=5)
            except Exception:
                pass  # 退出路径尽力而为
        finally:
            await core.close()
            if tty_attrs is not None:
                # 退出时 input() 可能仍阻塞着（二次 Ctrl+C 路径），readline 来不及
                # 恢复终端模式，这里兜底还原
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, tty_attrs)


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

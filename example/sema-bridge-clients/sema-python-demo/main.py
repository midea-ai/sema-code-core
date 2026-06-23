import asyncio
import signal
import sys
import os
from typing import Optional

from sema_core_client import SemaCoreClient
from sema_core_config import SemaCoreConfig

# tty/termios 仅 Unix 支持（对应 JS 的 setRawMode）
try:
    import tty
    import termios
    import select as _select
    HAS_TTY = True
except ImportError:
    HAS_TTY = False

# 全局 raw mode 标志，monitor_escape 激活时为 True
_raw_mode: bool = False


def gray(s: str) -> str:  return f"\033[90m{s}\033[0m"
def blue(s: str) -> str:  return f"\033[34m{s}\033[0m"
def green(s: str) -> str: return f"\033[32m{s}\033[0m"


def rwrite(text: str, end: str = "\n", flush: bool = True) -> None:
    """在 raw mode 下用 \\r\\n 代替 \\n，否则走正常 print。"""
    if _raw_mode:
        out = (text + end).replace("\r\n", "\n").replace("\n", "\r\n")
        sys.stdout.write(out)
        if flush:
            sys.stdout.flush()
    else:
        print(text, end=end, flush=flush)


async def ainput(prompt: str = "") -> str:
    """异步读取用户输入（不阻塞事件循环）"""
    rwrite(prompt, end="")
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, sys.stdin.readline)


async def monitor_escape(client, stop_event: asyncio.Event) -> None:
    """监听 ESC 键（对应 JS 的 keypress/escape），仅在 AI 响应期间启用"""
    global _raw_mode
    if not HAS_TTY or not sys.stdin.isatty():
        return
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        _raw_mode = True
        loop = asyncio.get_event_loop()
        while not stop_event.is_set():
            r = await loop.run_in_executor(
                None, lambda: _select.select([sys.stdin], [], [], 0.1)[0]
            )
            if r and not stop_event.is_set():
                ch = os.read(fd, 1)
                if ch == b'\x1b':
                    asyncio.ensure_future(client.interrupt())
    except (asyncio.CancelledError, Exception):
        pass
    finally:
        _raw_mode = False
        try:
            termios.tcsetattr(fd, termios.TCSADRAIN, old)
        except Exception:
            pass


async def main() -> None:
    BRIDGE_URL = "ws://localhost:3765"

    print("=== Sema Python Demo ===")
    print(f"Connecting to sema-bridge at {BRIDGE_URL}...\n")

    client = SemaCoreClient()
    session_id: Optional[str] = None
    current_state: dict = {"value": "idle"}
    esc_state: dict = {"stop": asyncio.Event(), "task": None}

    # main 代理判断：agentId 为 "main" 或 None/空 即视为主代理
    def is_main(agent_id) -> bool:
        return agent_id == "main" or not agent_id

    # ── 日志事件（灰色输出，对应 quickstart.mjs events 数组）────────
    for evt_name in [
        "tool:execution:start", "tool:execution:complete", "tool:execution:error",
        "tool:permission:request", "task:agent:start", "task:agent:end",
        "todos:update", "session:interrupted",
    ]:
        def make_log_handler(name: str):
            def handler(data):
                rwrite(gray(f"{name}|{data if data is not None else ''}"))
            return handler
        client.on(evt_name, make_log_handler(evt_name))

    # ── 子代理深度跟踪：message:text:chunk 不带 agentId，靠 task:agent:start/end
    #    包裹判断是否在子代理内（对应 quickstart.mjs:93-103）────────
    sub_agent_depth: dict = {"value": 0}
    client.on("task:agent:start", lambda _: sub_agent_depth.update(value=sub_agent_depth["value"] + 1))
    client.on("task:agent:end", lambda _: sub_agent_depth.update(value=max(0, sub_agent_depth["value"] - 1)))

    # ── 流式输出：仅主代理（depth==0），避免子代理文本混入主输出 ──────
    def on_text_chunk(data):
        if sub_agent_depth["value"] > 0:
            return
        if data and "delta" in data:
            delta = data["delta"]
            if _raw_mode:
                delta = delta.replace("\r\n", "\n").replace("\n", "\r\n")
            sys.stdout.write(delta)
            sys.stdout.flush()

    client.on("message:text:chunk", on_text_chunk)

    # ── 权限交互（对应 quickstart.mjs 的 tool:permission:request 处理）─
    async def handle_permission(data):
        tool_id = data.get("toolId", "") if data else ""
        tool_name = data.get("toolName", "") if data else ""
        await stop_esc()  # 退出 raw mode，确保 readline 可正常接收回车
        answer = (await ainput(blue("👤 权限响应 (y=agree / a=allow / n=refuse): "))).strip()
        selected = {"y": "agree", "a": "allow", "n": "refuse"}.get(answer, "agree")
        await client.respond_to_permission(tool_id, tool_name, selected)
        await start_esc()  # 重新启动 ESC 监听

    client.on("tool:permission:request",
              lambda data: asyncio.ensure_future(handle_permission(data)))

    # ── 连接 ──────────────────────────────────────────────────────
    try:
        await asyncio.wait_for(client.connect(BRIDGE_URL), timeout=10.0)
        print("Connected!\n")
    except Exception as e:
        print(f"Failed to connect: {e}", file=sys.stderr)
        print("Make sure sema-bridge is running: cd sema-bridge && npm start", file=sys.stderr)
        return

    # 提前声明，供 handle_interrupt 在会话循环建立前安全引用
    loop_done: Optional[asyncio.Future] = None

    # ── Ctrl+C 中断：idle 状态优雅退出（走正常关闭路径），否则 interrupt ──
    def handle_interrupt():
        nonlocal loop_done
        rwrite("\n⚠️  中断会话...")
        if current_state["value"] == "idle":
            # 解析 loop_done 让 finally 执行清理（client.close()/termios 复位），
            # 而非 sys.exit(0) 绕过收尾。
            if loop_done is not None and not loop_done.done():
                loop_done.set_result(None)
        else:
            asyncio.ensure_future(client.interrupt())

    try:
        asyncio.get_event_loop().add_signal_handler(signal.SIGINT, handle_interrupt)
    except NotImplementedError:
        pass  # Windows 不支持 add_signal_handler

    async def start_esc() -> None:
        esc_state["stop"] = asyncio.Event()
        esc_state["task"] = asyncio.ensure_future(
            monitor_escape(client, esc_state["stop"])
        )

    async def stop_esc() -> None:
        if esc_state["task"] is not None:
            esc_state["stop"].set()
            try:
                await asyncio.wait_for(esc_state["task"], timeout=0.5)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
            esc_state["task"] = None

    try:
        # ── 核心配置（对应 quickstart.mjs 的 new SemaCore({...}) 选项）──────
        await client.init_core(
            SemaCoreConfig(
                working_dir="/path/to/your/project",  # Agent 将操作的目标代码仓库路径
                log_level="none",
                thinking=False,
                disable_background_tasks=True,
                disable_topic_detection=True,
                disabled_tools=["ask_form", "plan_to_agent"],  # 交互场景禁用无法应答的工具
            )
        )

        # ── 配置模型（以 deepseek 为例，更多LLM服务商请见"新增模型"文档）──────
        # 只需要加一次，后面可以注释掉添加模型相关代码
        model_config = {
            "modelName":     "deepseek-v4-flash",
            "provider":      "deepseek",
            "baseURL":       "https://api.deepseek.com/anthropic",
            "apiKey":        "sk-your-api-key",
            "maxTokens":     32000,
            "contextLength": 256000,
            "adapt":         "anthropic",
        }
        await client.add_model(model_config, skip_validation=False)
        model_id = "deepseek-v4-flash[deepseek]"
        await client.apply_task_model(model_id, model_id)
        print(f"Model configured: {model_id}\n")

        # ── 创建会话，等待 session:ready ──────────────────────────
        ready_task = asyncio.ensure_future(
            client.wait_for_event("session:ready", timeout=30.0)
        )
        await client.create_session()
        session_data = await ready_task
        session_id = session_data.get("sessionId", "") if session_data else ""
        print(f"Session ready: {session_id}\n")

        # 对话循环：以主代理回到 idle 作为一轮结束信号
        loop_done = asyncio.get_event_loop().create_future()
        awaiting_input: dict = {"value": False}  # 防止多个结束信号并发重复弹输入

        def on_session_error(data):
            msg = data.get("message", "Unknown error") if data else "Unknown error"
            if not loop_done.done():
                loop_done.set_exception(Exception(msg))

        client.once("session:error", on_session_error)

        # 跟踪状态（供 Ctrl+C 判断），并在回到 idle 时弹下一条输入
        def on_state_update(data):
            if data:
                current_state["value"] = data.get("state", "idle")
                if current_state["value"] == "idle":
                    asyncio.ensure_future(ask_and_send())

        client.on("state:update", on_state_update)

        async def ask_and_send():
            if awaiting_input["value"] or loop_done.done():
                return
            awaiting_input["value"] = True
            await stop_esc()  # 退出 raw mode，确保 readline 可正常接收回车
            user_input = (await ainput(blue("\n👤 消息 (esc中断): "))).strip()
            awaiting_input["value"] = False
            if loop_done.done():
                return
            if user_input in ("exit", "quit"):
                loop_done.set_result(None)
                return
            if not user_input:  # 空输入：重新询问
                asyncio.ensure_future(ask_and_send())
                return
            rwrite(green("\n🤖 AI: "), end="")
            await start_esc()
            await client.send_user_input(user_input)

        # 主代理消息结束：仅换行（弹输入交给 state:update=idle）
        def on_message_complete(data):
            agent_id = data.get("agentId") if data else None
            if not is_main(agent_id):
                return
            sys.stdout.write("\r\n" if _raw_mode else "\n")
            sys.stdout.flush()

        client.on("message:complete", on_message_complete)

        # 被中断后重新弹输入（对应 quickstart.mjs:141）
        client.on("session:interrupted", lambda _: asyncio.ensure_future(ask_and_send()))

        # 初始 prompt（对应 quickstart.mjs 对话循环中立即执行的 async IIFE）
        asyncio.ensure_future(ask_and_send())
        try:
            await loop_done
        except asyncio.CancelledError:
            # Windows上Ctrl+C会取消loop_done，优雅退出
            pass

    except Exception as e:
        print(f"[Error] {e}", file=sys.stderr)
    finally:
        await stop_esc()
        await client.close()

    print("\n=== 会话结束 ===")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as err:
        print(f"错误: {err}", file=sys.stderr)
        sys.exit(1)

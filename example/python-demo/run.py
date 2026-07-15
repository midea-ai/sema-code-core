"""入口 2：一次性执行（非交互）—— example/demo/src/run.ts 的 Python 镜像。

用法：
    python run.py <项目路径> "<用户输入>" [verbose|medium|simple|minimal]

详略档位（所有工具都只打印「标题」）：
    verbose  详细：AI 文本 + 全部工具标题 + 错误 + 子代理 + todos
    medium   中等：AI 文本 + 仅文件编辑/终端工具标题
    simple   简单：仅同步 AI 文本内容
    minimal  极简：仅同步最终结论

模型自动读取 ~/.sema/model.conf（见 README），代码里无需配置模型。
"""
from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path

from sema_sdk import MAIN_AGENT_ID, SemaCore, SemaEvents

# 文件编辑 / 终端类工具名（medium 档位只展示这些工具的标题）
EDIT_TERMINAL_TOOLS = {"write_file", "patch_file", "edit_notebook", "run_shell"}
# 文件编辑类（不含 run_shell）：标题后附带 +增 -删 行数
FILE_EDIT_TOOLS = {"write_file", "patch_file", "edit_notebook"}

gray = lambda s: f"\x1b[90m{s}\x1b[0m"   # noqa: E731
green = lambda s: f"\x1b[32m{s}\x1b[0m"  # noqa: E731


def tool_icon(tool_name: str) -> str:
    """按工具类型给区分化图标，比单一 🔧 更易辨认。"""
    if tool_name in FILE_EDIT_TOOLS:
        return "📝"
    if tool_name == "run_shell":
        return "💻"
    if tool_name == "skill":
        return "🧩"
    if tool_name.startswith("mcp__"):
        return "🔌"
    if tool_name == "fetch_url":
        return "🌐"
    return "🔧"


def format_diff_stat(content) -> str:
    """从工具 content（结构 {type, patch}）统计 +增 -删，如 "+12 -2" / "+12" / ""。"""
    if not isinstance(content, dict) or not isinstance(content.get("patch"), list):
        return ""
    added = removed = 0
    if content.get("type") == "new":
        for h in content["patch"]:
            added += h.get("newLines", 0) if isinstance(h, dict) else 0
    else:
        for h in content["patch"]:
            for line in (h.get("lines") or []) if isinstance(h, dict) else []:
                if isinstance(line, str) and line.startswith("+"):
                    added += 1
                elif isinstance(line, str) and line.startswith("-"):
                    removed += 1
    parts = ([f"+{added}"] if added else []) + ([f"-{removed}"] if removed else [])
    return " ".join(parts)


def _split_and(title: str) -> list[str]:
    return [s.strip() for s in re.split(r"\s+&&\s+", title.strip()) if s.strip()]


def _is_ls(title: str) -> bool:
    """title 形如 `cd a && ls foo`：跳过开头的 cd 段后剩余命令以 ls 开头即视为列目录。"""
    segs = _split_and(title)
    i = 0
    while i < len(segs) - 1 and re.match(r"^cd(\s|$)", segs[i]):
        i += 1
    return i < len(segs) and bool(re.match(r"^ls(\s|$)", segs[i]))


def _is_find(title: str) -> bool:
    """find 查找（排除 -delete/-exec 等有副作用的破坏性用法）。"""
    c = title.strip()
    if not re.match(r"^find(\s|$)", c):
        return False
    return not re.search(r"(^|\s)-(delete|exec|execdir|ok|okdir)(\s|$)", c)


def _is_pwd(title: str) -> bool:
    return bool(re.match(r"^pwd(\s+-(L|P))*\s*$", title.strip()))


def _is_exploratory(title: str) -> bool:
    """由 && 串起且每段都是 ls / find / pwd 的纯探查链。"""
    segs = _split_and(title)
    return len(segs) >= 2 and all(_is_ls(s) or _is_find(s) or _is_pwd(s) for s in segs)


def read_tool_bucket(tool_name: str, title: str) -> str | None:
    """只读探查类工具归桶；其余返回 None 照常单条展示。"""
    if tool_name == "view_file":
        return "文件"
    if tool_name in ("search_files", "search_content"):
        return "搜索"
    if tool_name == "run_shell":
        if _is_ls(title):
            return "目录"
        if _is_find(title) or _is_pwd(title) or _is_exploratory(title):
            return "探查"
    return None


async def main() -> None:
    positional = [a for a in sys.argv[1:] if not a.startswith("-")]
    if len(positional) < 2:
        print('用法: python run.py <项目路径> "<用户输入>" [verbose|medium|simple|minimal]', file=sys.stderr)
        sys.exit(1)
    project_path, user_input = positional[0], positional[1]
    verbosity = positional[2] if len(positional) > 2 else "verbose"
    if not Path(project_path).is_dir():
        print(f"项目路径不存在或不是目录: {project_path}", file=sys.stderr)
        sys.exit(1)
    if verbosity not in ("verbose", "medium", "simple", "minimal"):
        print(f'未知档位 "{verbosity}"，可选：verbose | medium | simple | minimal', file=sys.stderr)
        sys.exit(1)

    is_minimal = verbosity == "minimal"
    is_verbose = verbosity == "verbose"

    # ≙ Node: new SemaCore({...})，配置项一字不差。
    # 非交互：直接跳过所有权限检查，避免一次性执行卡在权限询问
    # （不同于 AutoRun——AutoRun 仍会用快速模型判断，命中风险会转人工，无人应答时会挂起）
    core = await SemaCore.start({
        "workingDir": project_path,
        "logLevel": "none",
        "thinking": True,
        "disableTopicDetection": True,
        "disableBackgroundTasks": True,
        "disabledTools": ["ask_form", "plan_to_agent"],
        "skipShellExecPermission": True,
        "skipFileEditPermission": True,
        "skipSkillPermission": True,
        "skipMCPToolPermission": True,
        "skipFetchUrlPermission": True,
        "skipExternalFileReadPermission": True,
    })
    try:
        session = await core.create_session()

        state = {"final_text": "", "pending_newline": False, "sub_agent_depth": 0}
        pending_reads: list[str] = []  # 攒批的只读探查桶名

        def is_main(agent_id) -> bool:
            return agent_id in (None, MAIN_AGENT_ID)

        def flush_newline() -> None:
            if state["pending_newline"]:
                print()
                state["pending_newline"] = False

        def flush_read_batch() -> None:
            """连续的只读探查工具合并成一条 🔍 汇总，避免逐条刷屏。"""
            if not pending_reads:
                return
            parts = []
            for bucket, label in (("文件", "读取 {} 个文件"), ("搜索", "搜索 {} 次"),
                                  ("目录", "列出 {} 个目录"), ("探查", "探查 {} 次")):
                n = pending_reads.count(bucket)
                if n:
                    parts.append(label.format(n))
            pending_reads.clear()
            flush_newline()
            print(gray(f"🔍 {'、'.join(parts)}"))

        def on_agent_start(d) -> None:
            state["sub_agent_depth"] += 1
            if is_verbose:
                flush_newline()
                print(gray(f"🤖 子代理开始: {(d or {}).get('title', '')}"))

        def on_agent_end(d) -> None:
            state["sub_agent_depth"] = max(0, state["sub_agent_depth"] - 1)
            if is_verbose:
                print(gray(f"✅ 子代理结束: {(d or {}).get('title', '')}"))

        session.on(SemaEvents.TASK_AGENT_START, on_agent_start)
        session.on(SemaEvents.TASK_AGENT_END, on_agent_end)

        # 文本流式（仅主代理）；minimal 不流式，只在 message:complete 记录结论
        if not is_minimal:
            def on_chunk(d) -> None:
                delta = (d or {}).get("delta")
                if state["sub_agent_depth"] > 0 or not delta:
                    return
                flush_read_batch()  # 主代理开始说话前，先把攒着的只读探查汇总打出来
                sys.stdout.write(delta)
                sys.stdout.flush()
                state["pending_newline"] = True

            session.on(SemaEvents.MESSAGE_TEXT_CHUNK, on_chunk)

        def on_complete(d) -> None:
            d = d or {}
            if not is_main(d.get("agentId")):
                return
            if not is_minimal:
                flush_newline()
            # 只在本轮不再调工具（turn 结束）时冲刷；中间的纯工具轮不切断连续的只读探查
            if not d.get("hasToolCalls"):
                flush_read_batch()
                if d.get("content"):
                    state["final_text"] = d["content"]

        session.on(SemaEvents.MESSAGE_COMPLETE, on_complete)

        if is_verbose or verbosity == "medium":
            def on_tool(d) -> None:
                d = d or {}
                if not is_main(d.get("agentId")):
                    return
                tool_name = d.get("toolName", "")
                title = (d.get("title") or "").strip()
                bucket = read_tool_bucket(tool_name, title)
                if bucket:  # 只读探查类：verbose 攒着合并汇总；medium 不显示只读信息
                    if is_verbose:
                        pending_reads.append(bucket)
                    return
                # medium 只展示文件编辑与终端工具，其余（skill / mcp / fetch 等）不外发
                if verbosity == "medium" and tool_name not in EDIT_TERMINAL_TOOLS:
                    return
                flush_read_batch()
                flush_newline()
                stat = format_diff_stat(d.get("content")) if tool_name in FILE_EDIT_TOOLS else ""
                print(gray(f"{tool_icon(tool_name)} {title or tool_name}{' ' + stat if stat else ''}"))

            session.on(SemaEvents.TOOL_EXECUTION_COMPLETE, on_tool)
        if is_verbose:
            def on_tool_error(d) -> None:
                d = d or {}
                if not is_main(d.get("agentId")):
                    return
                flush_read_batch()
                flush_newline()
                print(gray(f"❌ {(d.get('title') or '').strip() or d.get('toolName') or '工具执行失败'}"))

            session.on(SemaEvents.TOOL_EXECUTION_ERROR, on_tool_error)
            session.on(SemaEvents.TODOS_UPDATE, lambda d: (
                flush_read_batch(), flush_newline(),
                print(gray(f"📋 todos: {len(d) if isinstance(d, list) else 0} 项"))))

        # 完成信号：主代理回到 idle（整轮含工具调用结束后只发一次 idle）
        done: asyncio.Future = asyncio.get_running_loop().create_future()
        session.once(SemaEvents.SESSION_ERROR, lambda d: (
            flush_read_batch(),
            not done.done() and done.set_exception(RuntimeError(
                ((d or {}).get("error") or {}).get("message") or (d or {}).get("type") or str(d)))))
        session.on(SemaEvents.STATE_UPDATE, lambda d: (
            (d or {}).get("state") == "idle" and not done.done() and done.set_result(None)))
        session.once(SemaEvents.SESSION_READY,
                     lambda d: asyncio.ensure_future(session.process_user_input(user_input)))
        await done

        if is_minimal:
            print(green(state["final_text"] or "(无结论)"))
        await session.close()
    finally:
        await core.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except RuntimeError as e:
        print(f"错误: {e}", file=sys.stderr)
        sys.exit(1)

# sema-core Python Demo

`example/demo`（Node 示例）的 Python 镜像，直接依赖官方 Python SDK（pip 包 `sema-core`，模块 `sema_sdk`）。方法名（snake_case 机械映射）、参数名、事件名与 Node 版一致——对照两边源码可以看到逐节对应关系：

| 入口 | Node 版 | Python 版 |
|---|---|---|
| 交互式 CLI | `demo/src/cli.ts` | `cli.py` |
| 一次性执行（非交互） | `demo/src/run.ts` | `run.py` |

```python
# 起步代码与 Node 逐行对照（sidecar 内嵌在 SDK 包里，自动释放拉起，无需任何路径配置）：
core = await SemaCore.start({"workingDir": project_dir})   # ≙ new SemaCore({workingDir})
session = await core.create_session()                      # ≙ await core.createSession()
session.on("message:text:chunk", lambda d: print(d["delta"], end=""))
await session.process_user_input("你好")                    # ≙ session.processUserInput('你好')
await core.close()                                          # ≙ await core.dispose()
```

## 前置条件

- Python 3.10+；Node ≥18（SDK 只做本地探测，没有时装一个或设 `SEMA_NODE_PATH`）
- 模型配置 `~/.sema/model.conf`（sema-core 自动读取，demo 代码不涉及模型配置；格式见 [`example/demo/README.md`](../demo/README.md)）

## 安装与运行

```bash
# ① 在 demo 目录建 venv 并安装 SDK
cd example/python-demo
python3 -m venv .venv
source .venv/bin/activate
pip install sema-core

# ② 运行 demo（venv 已激活；系统 python3 没装 SDK，不激活会报
#    ModuleNotFoundError: No module named 'sema_sdk'）
python cli.py /path/to/project              # 交互式 CLI，新建会话（≙ npm run cli）
python cli.py /path/to/project <会话id>      # 加载历史会话
python run.py /path/to/project "列出 src 结构" verbose   # 一次性执行（≙ npm run exec）
```

交互方式与 Node 版一致：直接输入消息回车对话（如"你好"），权限询问输 `y`/`n`，`esc`/`Ctrl-C` 第一次中断当前轮、第二次退出，输入 `exit`/`quit` 结束。

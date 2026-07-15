# Sema Python SDK

[Sema Code Core](https://github.com/midea-ai/sema-code-core) 的官方 Python SDK：一个事件驱动的 AI 编程助手核心引擎,支持多代理协作、Skill 扩展、Plan 模式任务规划等能力。SDK 内嵌 core 运行时(sidecar),`pip install` 后开箱即用,asyncio-first。

## 安装

```bash
pip install sema-core
```

要求:Python 3.10+,本机 Node.js ≥ 18(core 运行时依赖)。

## 快速开始

```python
import asyncio
from sema_sdk import SemaCore

async def main():
    core = await SemaCore.start({"workingDir": "/path/to/your/project"})
    session = await core.create_session()
    session.on("message:text:chunk", lambda d: print(d["delta"], end="", flush=True))
    await session.process_user_input("你好")
    await core.close()

asyncio.run(main())
```

模型配置与更多用法见 [文档](https://midea-ai.github.io/sema-code-core),完整示例见 [example/python-demo](https://github.com/midea-ai/sema-code-core/tree/main/example/python-demo)(交互式 CLI 与一次性执行)。

## License

[MIT](https://github.com/midea-ai/sema-code-core/blob/main/LICENSE)

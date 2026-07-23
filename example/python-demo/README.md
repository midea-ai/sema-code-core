# sema-core Python Demo

## 前置条件

- Python 3.10+；Node ≥18（SDK 本地优先探测，探测不到自动下载到 `~/.sema/node`）
- 模型配置 `~/.sema/model.conf`（sema-core 自动读取，demo 代码不涉及模型配置；格式见 [`模型配置`](https://midea-ai.github.io/sema-code-core/#/wiki/getting-started/basic-usage/add-new-model?id=%E6%8C%81%E4%B9%85%E5%8C%96)）

## 安装 sema-core

```bash
# 在 demo 目录建 venv 并安装 SDK
cd example/python-demo
python3 -m venv .venv
source .venv/bin/activate
pip install sema-core
```

也可从 [releases](https://github.com/midea-ai/sema-code-core/releases/latest) 下载最新的 whl 文件，再 `pip install <whl 文件路径>` 安装。

## 运行

```bash
python cli.py /path/to/project              # 交互式 CLI，新建会话
python cli.py /path/to/project <会话id>      # 加载历史会话
python run.py /path/to/project "列出 src 结构" verbose   # 一次性执行
```

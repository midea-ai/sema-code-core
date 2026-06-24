# sema-core TypeScript Demo

一个最小化的 TypeScript 示例工程，演示 [`sema-core`](https://www.npmjs.com/package/sema-core) 的两种用法：

1. **交互式 CLI**（`src/cli.ts`）：在终端里多轮对话，支持流式输出、esc 中断、权限询问。
2. **一次性执行**（`src/run.ts`）：传入项目路径、用户输入与详略档位，执行单条指令后退出。

> 代码里**不包含任何模型配置**——`sema-core` 启动时会自动读取 `~/.sema/model.conf`。请先按下方第 2 步创建该文件。

---

## 1. 安装

```bash
cd example/demo
npm install
```

## 2. 配置模型：创建 `~/.sema/model.conf`

首次使用前，在用户主目录下创建 `~/.sema/model.conf`，内容如下（把 `apiKey` 换成你自己的）：

```jsonc
{
    "modelProfiles": [
        {
            "name": "deepseek-v4-flash[deepseek]",
            "provider": "deepseek",
            "modelName": "deepseek-v4-flash",
            "baseURL": "https://api.deepseek.com/anthropic",
            "apiKey": "sk-",
            "maxTokens": 32000,
            "contextLength": 256000,
            "adapt": "anthropic"
        },
        {
            "name": "deepseek-v4-pro[deepseek]",
            "provider": "deepseek",
            "modelName": "deepseek-v4-pro",
            "baseURL": "https://api.deepseek.com/anthropic",
            "apiKey": "sk-",
            "maxTokens": 32000,
            "contextLength": 256000,
            "adapt": "anthropic"
        }
    ],
    "modelPointers": {
        "main": "deepseek-v4-pro[deepseek]",
        "quick": "deepseek-v4-flash[deepseek]"
    }
}
```

字段说明：
- `modelProfiles`：模型列表，`name` 形如 `<modelName>[<provider>]`，唯一标识一个模型。
- `modelPointers.main`：主模型（对话/工具调用）；`modelPointers.quick`：快速模型（轻量判断）。

---

## 3. 入口 1：交互式 CLI

```bash
# 指定要操作的项目路径（必填），新建会话
npm run cli /path/to/your/project

# 指定目录 + 加载历史会话（第二个参数为会话id）
npm run cli /path/to/your/project 194fb8de
```

**参数**

| 位置 | 参数 | 说明 |
|---|---|---|
| 1 | 项目路径 | Agent 操作的目标仓库（**必填**） |
| 2 | 会话id | 可选，传入则加载该历史会话继续对话，缺省则新建 |

> 启动后终端会打印当前 `会话id`，记下它即可在下次用第二个参数恢复对话。

进入后直接输入消息回车即可对话：
- `esc` / `Ctrl-C`：第一次中断当前回复，第二次退出。
- 工具执行需要权限时，输入 `y`（本次同意）/ `n`（拒绝）。
- 输入 `exit` 或 `quit` 结束会话。

## 4. 入口 2：一次性执行

```bash
npm run exec <项目路径> "<用户输入>" [详略档位]
```

示例：

```bash
npm run exec /path/to/your/project "列出 src 下的所有文件并总结结构" verbose
```

多行输入：用单引号包裹，直接换行即可（换行会原样传给模型）：

```bash
npm run exec /path/to/your/project '帮我做两件事：
1. 列出 src 下的所有文件
2. 总结整体结构' verbose
```

**参数**

| 位置 | 参数 | 说明 |
|---|---|---|
| 1 | 项目路径 | Agent 操作的目标仓库（绝对路径） |
| 2 | 用户输入 | 要执行的指令，含空格/换行请用引号包裹（单引号更安全，不会展开 `$`、反引号等） |
| 3 | 详略档位 | `verbose` / `medium` / `simple` / `minimal`，缺省 `verbose` |

**详略档位**（所有工具都只打印「标题」，不打印参数和结果内容）

| 档位 | 含义 | 打印内容 |
|---|---|---|
| `verbose` | 详细 | AI 文本 + 全部工具标题 + 错误 + 子代理 + todos |
| `medium`  | 中等 | AI 文本 + 仅文件编辑/终端工具标题（`write_file`/`patch_file`/`edit_notebook`/`run_shell`） |
| `simple`  | 简单 | 仅同步 AI 文本内容 |
| `minimal` | 极简 | 仅同步最终结论 |

> 一次性执行通过 `skipShellExecPermission` / `skipFileEditPermission` / `skipSkillPermission` / `skipMCPToolPermission` / `skipFetchUrlPermission` / `skipExternalFileReadPermission` 直接跳过所有权限检查，全程无需人工确认。
> （与 `AutoRun` 不同：`AutoRun` 仍会用快速模型判断安全性，命中风险会转人工申请，非交互场景下无人应答会挂起。）

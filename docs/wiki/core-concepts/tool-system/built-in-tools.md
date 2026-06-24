# 内置工具概览

内置工具是 Sema Core 默认提供给 Agent 的基础能力集合。它们和 MCP 工具一样实现统一的 `Tool<TInput, TOutput>` 接口，会被转换为模型可调用的 tool schema，并在对话循环中由 `RunTools` 负责权限检查、执行、结果回传和事件通知。

当前内置工具共 21 个，覆盖文件读写、代码搜索、终端执行、网页抓取、子代理、后台任务、任务管理、定时任务和用户交互等场景。宿主应用可以通过 `useTools` 控制启用范围，也可以通过权限配置决定哪些高风险操作需要用户确认。

## 工具清单

| 工具 | 能力 | 安全工具 | 说明 |
|------|------|----------|------|
| `run_shell` | 终端执行 | 否 | 在持久化 shell 中执行命令，支持中断和后台任务 |
| `search_files` | 文件搜索 | 是 | 按 glob 模式查找文件 |
| `search_content` | 文本搜索 | 是 | 在文件内容中搜索关键词或正则 |
| `view_file` | 文件读取 | 是 | 读取指定文件内容 |
| `write_file` | 文件写入 | 否 | 创建或整体覆盖文件 |
| `patch_file` | 文件编辑 | 否 | 对文件做局部修改并生成 diff 摘要 |
| `fetch_url` | 网页抓取 | 否 | 获取 URL 内容并转为模型可读文本 |
| `sub_agent` | 子代理 | 否 | 启动子代理处理独立任务，支持并发和后台任务 |
| `peek_bg_job` | 后台任务读取 | 是 | 读取 `run_shell` / `sub_agent` 后台任务输出 |
| `stop_bg_job` | 后台任务停止 | 否 | 停止正在运行的后台任务 |
| `Skill` | Skill 调用 | 否 | 加载并执行本地 Skill 内容 |
| `NotebookEdit` | Notebook 编辑 | 否 | 修改 Jupyter Notebook 单元格 |
| `ask_form` | 用户交互 | 否 | 向用户展示结构化表单并等待提交 |
| `plan_to_agent` | Plan 模式切换 | 否 | 从 Plan 模式交还给 Agent 执行 |
| `create_todo` | 任务创建 | 否 | 创建待办任务，支持并发 |
| `get_todo` | 任务查询 | 是 | 查询单个任务详情，支持并发 |
| `list_todos` | 任务列表 | 是 | 列出任务，支持并发 |
| `update_todo` | 任务更新 | 否 | 更新任务状态、内容或依赖，支持并发 |
| `create_cron` | 定时任务创建 | 否 | 创建定时任务，支持并发，仅主代理可用 |
| `del_cron` | 定时任务删除 | 否 | 删除定时任务，支持并发 |
| `list_crons` | 定时任务列表 | 是 | 列出定时任务，支持并发 |

## 能力分组

### 文件与代码操作

`search_files`、`search_content`、`view_file` 用于只读探索，默认视为安全工具，可跳过权限确认并参与并发执行。`write_file` 和 `patch_file` 会修改工作区内容，默认需要权限确认；局部修改优先使用 `patch_file`，因为它能保留上下文并生成更清晰的 diff。

### 命令与外部内容

`run_shell` 提供命令执行能力，适合运行测试、构建、代码生成和项目脚本。它共享持久化 shell 状态，但会限制高风险命令和跨出工作目录的 `cd`。`fetch_url` 用于读取网页内容，属于可能访问外部资源的非安全工具，默认也会进入权限流程。

### 子代理与后台任务

`sub_agent` 可以把独立问题交给子代理处理；`run_shell` 和 `sub_agent` 都可以通过后台任务模式长时间运行。后台任务启动后，Agent 使用 `peek_bg_job` 获取输出，用 `stop_bg_job` 停止任务。读取后台任务是安全操作，停止后台任务会改变运行状态，因此需要权限确认。

### 任务和定时任务

`create_todo`、`get_todo`、`list_todos`、`update_todo` 组成会话内任务管理能力，适合让 Agent 跟踪多步骤工作。`create_cron`、`del_cron`、`list_crons` 管理定时任务，其中创建定时任务只允许主代理执行，避免子代理绕过主流程创建长期任务。

### 交互与扩展

`ask_form` 用于在必要时向用户请求结构化输入，支持单选、多选、下拉、单行文本和多行文本题型。`Skill` 工具通过 Skill 注册表加载本地技能内容，为模型注入特定工作流。`NotebookEdit` 面向 notebook 文件编辑，`plan_to_agent` 用于 Plan 模式到执行模式的切换。

## 安全与权限

每个工具都通过 `isSafe()` 声明是否无副作用。安全工具通常是只读能力，例如文件搜索、文件读取、任务列表查询；非安全工具包括命令执行、写文件、编辑文件、停止任务、创建任务或创建定时任务等。

非安全工具执行前会进入权限检查流程：

1. 若当前对话已被中断，直接返回取消结果。
2. 调用权限管理器检查该工具和输入是否已有授权。
3. 未授权时发布 `tool:permission:request` 事件，由宿主应用展示并回传选择。
4. 权限被拒绝时，工具不会执行，并向模型返回拒绝结果。

权限展示内容由工具的 `genToolPermission` 提供；执行完成后的 UI 展示内容由 `genToolResultMessage` 提供。更详细的权限规则见 [权限系统](wiki/core-concepts/permission-system/overview)。

## 并发、中断与后台任务

当模型在同一轮响应中发起多个工具调用时，Sema 会根据工具声明自动选择并发或串行执行：

- 所有工具都是安全工具，或都显式声明 `canRunConcurrently()` 时，可以并发执行。
- 只要存在一个非安全且不能并发的工具，本轮工具调用会串行执行。
- `run_shell` 和 `peek_bg_job` 支持中断后保留部分结果，其他工具通常会返回标准取消消息。
- `disableBackgroundTasks: true` 时，`run_shell` 和 `sub_agent` 的后台参数会从 schema 中移除，超时接管和主动后台运行也会被禁用。

相关机制见 [工具架构](wiki/core-concepts/tool-system/tool-architecture)、[RunShell 后台任务](wiki/core-concepts/task-management/bash-task) 和 [SubAgent 后台任务](wiki/core-concepts/task-management/agent-task)。

## 启用和过滤

宿主应用可以通过核心配置限制 Agent 可见的内置工具：

```javascript
import { getTools, getToolInfos, buildTools } from 'sema-core'

const tools = getTools(['view_file', 'search_files', 'search_content'])
const toolInfos = getToolInfos()
const sdkTools = buildTools(tools)
```

`getTools(null)` 返回全部内置工具；`getToolInfos()` 返回工具名称、描述和启用状态；`buildTools()` 会把内部工具对象转换为模型 API 所需的工具定义。

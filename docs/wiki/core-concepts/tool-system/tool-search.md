# 工具搜索（延迟加载）

随着 MCP server 接入增多，全部工具 schema 默认注入 LLM 请求会持续膨胀 prompt、挤占上下文。工具搜索模式（Tool Search）只让一个默认工具集进入 LLM 的 tools 列表，其余内置工具与 MCP 工具进入延迟池，由模型在需要时通过 `load_tools` 按名加载，下一轮生效。

该模式默认关闭，通过核心配置开启：

```typescript
const sema = new SemaCore({
  enableToolSearch: true,                    // 开启工具搜索（延迟加载），默认 false
  toolSearchDefaultTools: [                  // 可选：默认加载的工具白名单，不传用内置默认集
    'run_shell',
    'view_file',
    'mcp__figma__get_file',                  // MCP 工具全名
    'mcp__github__*',                        // 通配整台 server
  ],
})
```

`enableToolSearch` 支持运行时更新（`updateCoreConfByKey`），于下一次用户输入生效，切换后的首次请求前缀缓存会整体失效一次。`toolSearchDefaultTools` 仅构造时生效，不支持动态更新——中途变更会导致 tools 数组中段增删，破坏前缀缓存。

## 工作原理

开启后，每轮请求的 tools 数组按固定结构组装：

```
[默认加载工具（白名单序）] + [load_tools] + [会话已加载工具（加载序）]
```

- **默认加载工具**：白名单（或内置默认集）与当前可用工具求交后的结果，开场即可调用。
- **`load_tools`**：内置的加载工具，描述中携带完整的可加载名单（延迟内置工具名 + 各 MCP server 的工具清单），模型据此按名加载。
- **会话已加载工具**：模型此前通过 `load_tools` 加载的工具，按加载顺序追加。

整个数组是 append-only 的：默认段和 `load_tools` 位置固定，已加载段只增不减、只在尾部追加，保证 LLM 前缀缓存在多轮之间稳定命中。

`load_tools` 的一次调用会逐名校验：延迟池中存在则加载并触发上下文重建（`tools_loaded` 信号），新工具从下一轮起可调用；已在工具列表的名字提示直接调用；未命中的名字回报 not found，若全部未命中会附上完整可加载名单帮助模型纠正。

若白名单已覆盖全部可用工具（延迟池为空），则不注入 `load_tools`，行为与关闭该模式一致。

## 默认工具集

`toolSearchDefaultTools` 未配置时使用内置默认集，覆盖高频核心能力：

`run_shell`、`search_files`、`search_content`、`view_file`、`write_file`、`patch_file`、`sub_agent`、`skill`、`ask_form`、`plan_to_agent`

其余内置工具（后台任务、Todo、定时任务、`fetch_url`、`edit_notebook` 等）与全部 MCP 工具进入延迟池。

## 白名单规则

`toolSearchDefaultTools` 中的名字支持三种形式：

| 形式 | 示例 | 说明 |
|------|------|------|
| 内置工具名 | `run_shell` | 与 `useTools` 取交集，未启用的内置工具自动剔除 |
| MCP 工具全名 | `mcp__figma__get_file` | 与 LLM tools 中的 name 一致，即 `mcp__{server}__{tool}` |
| MCP 通配 | `mcp__github__*`、`mcp__github__get_*` | 通配整台 server 或按前缀匹配，展开为当前已连接的工具 |

通配必须具体到 server 且 server 名后带 `__`：`*`、`mcp__*`、`mcp__{server}*` 均不合法。未知工具名与不合法通配会记录警告后忽略，不影响其余配置生效。

## 子代理行为

- **未声明 tools 或声明为 `'*'` 的子代理**：同样收敛为默认集，并继承父会话已加载的工具（spawn 时快照），注入子代理视角的 `load_tools`。子代理自行加载的工具存放在 agent 级私有状态，随子代理结束清理，不影响父会话。
- **显式声明 tools 的子代理**：声明即所得，与工具搜索模式无关，不注入 `load_tools`。

子代理的工具集重组同样是 append-only：默认段与继承段冻结，仅自加载段增长，保证子代理自身的前缀缓存稳定。

## 相关源码

| 文件 | 职责 |
|------|------|
| `src/tools/LoadTools.ts` | `load_tools` 工具实现，含子代理专用包装 |
| `src/tools/base/tools.ts` | 默认集解析、延迟池计算、tools 数组组装 |
| `src/tools/base/subagentTools.ts` | 子代理工具集组装与重组闭包 |
| `src/core/Conversation.ts` | `tools_loaded` 信号处理与上下文重建 |

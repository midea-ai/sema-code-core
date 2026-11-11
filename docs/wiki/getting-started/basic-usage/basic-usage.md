# 基础用法

## SemaCoreConfig 配置项

创建 `SemaCore` 实例时可传入以下配置：

```javascript
interface SemaCoreConfig {
  configFile?: string;               // 构造配置文件路径（~/xx 或绝对路径），见下方「用文件配置」；仅构造时读一次
  workingDir?: string;               // 项目绝对路径
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none'; // 默认 'info'
  lang?: 'zh' | 'en' | 'de' | 'fr' | 'it'; // UI 可见文案语言（权限面板选项、Plan 退出选项、错误提示等），默认 'zh'；支持运行时更新，切换即时生效
  stream?: boolean;                  // 流式输出 AI 响应，默认 否
  thinking?: boolean;                // 流式输出 AI 思考过程，默认 否
  systemPrompt?: string;             // 系统提示
  systemPromptMode?: 'append' | 'replace' | 'replaceAll'; // 系统提示词模式，默认 'append'（叠加在内置提示词前）；'replace' 替换内置系统提示词（memory/env 上下文仍附加）；'replaceAll' 完全替换（仅 systemPrompt，不附加 memory/env/gitStatus，turn-level reminder 也不注入 MEMORY.md）；未配 systemPrompt 时回落 append，仅构造时生效
  customRules?: string;              // 用户规则（内联字符串），不传即无规则
  skipFileEditPermission?: boolean;  // 是否跳过文件编辑权限检查，默认 否
  skipShellExecPermission?: boolean; // 是否跳过 run_shell 执行权限检查，默认 否
  skipSkillPermission?: boolean;     // 是否跳过 Skill 权限检查，默认 否
  skipMCPToolPermission?: boolean;   // 是否跳过 MCP 工具权限检查，默认 否
  skipFetchUrlPermission?: boolean;  // 是否跳过 fetch_url 权限检查，默认 否
  skipExternalFileReadPermission?: boolean; // 是否跳过项目外文件读取权限检查，默认 否
  useTools?: string[] | null;        // 限定使用的工具，默认 null（使用所有工具）
  disabledTools?: string[] | null;   // 禁用工具黑名单，默认 null；与 useTools 同时传时优先生效
  agentMode?: 'Agent' | 'Plan' | 'Design'; // 会话默认模式，默认 'Agent'
  disableTopicDetection?: boolean;   // 是否禁用话题检测，默认 否
  enableInputPrediction?: boolean;   // 是否开启用户输入预测（一轮结束后用 quick 模型预测用户下一句，事件 input:predict），默认 否
  disableBackgroundTasks?: boolean;  // 是否禁止后台任务（RunShell 后台 / SubAgent 后台 / 超时转后台），默认 否
  disableMemory?: boolean;           // 是否关闭内置记忆（不拼记忆提示词、不注入 MEMORY.md、不读 .sema/memory、记忆文件编辑豁免失效），默认 否；仅构造时生效
  enableToolSearch?: boolean;        // 是否开启工具搜索（延迟加载），默认 否；开启后仅默认工具集进入 LLM tools，其余内置与 MCP 工具经 load_tools 按名加载；子代理（tools 为 '*' 或未声明）同样按需 load_tools，加载状态子代理私有、不影响父会话；运行时更新于下一次用户输入生效
  toolSearchDefaultTools?: string[] | null; // 工具搜索模式下默认加载的工具白名单，不传用内置默认集；可含内置工具名与 MCP 工具全名（如 'mcp__figma__get_file'），支持 mcp__{server}__* 通配整台 server、mcp__{server}__{prefix}* 前缀通配（须具体到 server，mcp__* 等不合法）；仅构造时生效
  maxSessions?: number;              // 同时存在的会话上限，不传则不限制
  usageProduct?: string;             // 使用统计的产品标识（如 'sema-code-vscode'），不传或空串则不采集；仅构造时生效，读取见 SemaCore.getUsageStats()

  // ---- 来源限定：宿主内置的 host 域内容与各类生效的域，仅构造时生效（类型见 sema-core/types 的 ModelsInput 等）----
  models?: ModelsInput;              // 宿主内置的模型与指针；只读，查询接口不回传 apiKey
  mcpServers?: MCPServerInput[];     // 宿主内置的 MCP 服务；查询接口与状态事件里 env / headers 值打码
  hooks?: HooksInput;                // 宿主内置的 hook（hooks.json 的 hooks 字段）
  skills?: SkillsInput;              // 宿主内置的 skill：items 内联（正文只在内存）、dirs 明文目录
  agents?: AgentsInput;              // 宿主内置的子代理，结构同 skills
  commands?: CommandsInput;          // 宿主内置的命令，结构同 skills
  scopes?: ScopesConfig;             // 各类生效的域，不写 = 全部生效；写接口落到没生效的域抛 SemaError(SCOPE_DISABLED)

  // ---- 持久化保护 ----
  encryption?: EncryptionConfig;     // 会话历史、快照、hook 会话记录加密（key 为 32 字节密钥的 base64），密钥只在内存；仅构造时生效
  disableLLMLog?: boolean;           // 不写模型调用日志；缺省：没传 encryption 为 false，传了为 true；支持运行期更新
  disableEventLog?: boolean;         // 不写事件日志；缺省规则同上；支持运行期更新
}
```

> 构造参数校验不通过、写接口落到没生效的域或 host 条目时抛 `SemaError`（`code` 为 `CONFIG_INVALID` / `SCOPE_DISABLED` / `HOST_READONLY`）；`createSession` 遇到解不开的加密历史返回 `{ ok: false, error, code: 'HISTORY_KEY_REQUIRED' | 'HISTORY_DECRYPT_FAILED' }`。

> 可通过 `sema.updateCoreConfByKey(key, value)` 或 `sema.updateCoreConfig(partial)` 在运行时更新 `UpdatableCoreConfigKeys` 中定义的字段。`disabledTools` 通过 `sema.updateDisabledTools()` 更新；`agentMode` 是会话级配置，创建会话时通过 `createSession({ agentMode })` 指定，运行中通过 `session.updateAgentMode()` 更新。

### 用文件配置

配置项多或提示词很长时，可以把构造配置放进一个 JSON 文件，构造时只传路径：

```javascript
const sema = new SemaCore({ configFile: '~/my-app/core.json' })
```

```json
{
  "workingDir": "/path/to/your/project",
  "systemPrompt": { "$file": "./prompts/system.md" },
  "customRules": { "$file": "~/rules/common.md" },
  "enableToolSearch": true,
  "scopes": { "plugins": [] }
}
```

- **文件内容**：严格 JSON（不支持注释），字段与 `SemaCoreConfig` 相同。
- **路径**：`configFile` 支持 `~/xx` 和绝对路径。
- **合并**：构造参数里显式传的顶层键整体覆盖文件里的同名键，不做深合并。
- **外置文本**：文件里任意位置的 `{ "$file": "路径" }` 会替换成该文件的文本，路径支持 `~/xx`、绝对路径，以及相对配置文件所在目录的相对路径。
- **出错**：文件读不到、不是合法 JSON、`$file` 指向的文件读不到时，构造同步抛 `SemaError`（`code` 为 `CONFIG_INVALID`）。

## 输出约定

系统提示会要求模型使用 KaTeX 分隔符输出数学公式：行内公式使用 `$...$`，块级公式使用 `$$...$$`。不要使用 `\(...\)` 或 `\[...\]`，需要输出字面量美元符号时写作 `\$`。

<figure align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/system-conf.png" alt="model-list">
  <figcaption>Sema Code vscode插件页面截图</figcaption>
</figure>

## 会话生命周期

```
创建实例 → 添加模型（可跳过） → 创建会话 → 处理输入 → [中断/继续] → 关闭会话/释放资源
```

### 1. 创建实例

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/your/project',
})
```

### 2. 添加模型（首次使用）

参考：[添加模型](wiki/getting-started/basic-usage/add-new-model?id=添加模型)

### 3. 创建会话

```javascript
// 新建会话
const result = await sema.createSession()

// 恢复已有会话（保留历史消息）时：
// const result = await sema.createSession({ sessionId: 'existing-session-id' })

if (!result.ok) throw new Error(result.error)
const session = result.session
```

`createSession` 完成后会触发 `session:ready` 事件：

```javascript
session.on('session:ready', ({ pid, workingDir, sessionId, historyLoaded, usage, todos, projectInputHistory, readFileTimestamps }) => {
  console.log('会话已就绪:', sessionId)
  console.log('已恢复历史:', historyLoaded)
  console.log('当前 token:', usage.useTokens, '/', usage.maxTokens)
  console.log('历史输入记录:', projectInputHistory)
  console.log('文件读取时间戳:', readFileTimestamps)
})
```

其中事件数据包含：
- `pid`: Core 进程 ID
- `workingDir`: 工作目录路径
- `sessionId`: 会话唯一标识
- `historyLoaded`: 是否加载了历史记录
- `usage`: token 使用情况
- `projectInputHistory`: 项目历史输入记录
- `todos`: 待办事项列表
- `readFileTimestamps`: 文件读取时间戳

> 多个会话可以同时存在。`maxSessions` 可限制会话池大小；超过限制时 `createSession()` 返回 `{ ok: false, error }`。重复传入同一个 `sessionId` 会复用已有会话。

### 4. 处理用户输入

```javascript
// 非阻塞：立即返回，异步执行
session.processUserInput('帮我优化这个函数的性能')

// 监听完成
session.on('state:update', ({ state }) => {
  if (state === 'idle') console.log('执行完毕')
})
```

> 处理中再次调用 `processUserInput` 时，新输入会按 `command`（以 `/` 开头）/ `inject`（普通消息）类型自动入队，当前轮次结束后自动消费。`/quickchat <question>` 是旁路问答，不影响主对话状态，回复通过 `quickchat:response` 事件返回。

### 5. 中断执行

```javascript
// 可在任意时刻调用
session.interrupt()
```

触发 `session:interrupted` 事件，当前工具调用链被取消，AI 停止响应。

### 6. 释放资源

```javascript
// 应用退出前调用，释放 MCP 连接等资源
await sema.dispose()
```

## 完整使用示例

```javascript
import { SemaCore } from 'sema-core'
import * as readline from 'readline'

async function main() {
  const sema = new SemaCore({
    workingDir: process.cwd(),
  })

  const result = await sema.createSession()
  if (!result.ok) throw new Error(result.error)
  const session = result.session

  // 注册事件监听
  session.on('message:text:chunk', ({ delta }) => {
    process.stdout.write(delta ?? '')
  })

  session.on('state:update', ({ state }) => {
    if (state === 'idle') process.stdout.write('\n\n')
  })

  session.on('tool:execution:complete', ({ toolName, summary }) => {
    console.log(`\n  ✓ [${toolName}] ${summary}`)
  })

  session.on('tool:permission:request', ({ toolId, toolName, title }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`\n允许执行 "${title}"? (y/n): `, (answer) => {
      rl.close()
      session.respondToToolPermission({
        toolId,    // 必传：与请求事件中的 toolId 对应，用于精确匹配
        toolName,
        selected: answer.toLowerCase() === 'y' ? 'agree' : 'refuse',
      })
    })
  })

  session.on('session:error', ({ type, error }) => {
    console.error(`\n错误 [${type}]:`, error)
  })

  // REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const askQuestion = () => {
    rl.question('> ', (input) => {
      if (input === '/exit') {
        sema.dispose().then(() => process.exit(0))
      } else {
        session.processUserInput(input)
        session.once('state:update', ({ state }) => {
          if (state === 'idle') askQuestion()
        })
      }
    })
  }

  askQuestion()
}

main()
```


## 常见配置场景

### 全自动模式（无需权限确认）

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/project',
  skipFileEditPermission: true,
  skipShellExecPermission: true,
  skipSkillPermission: true,
  skipMCPToolPermission: true,
  skipFetchUrlPermission: true,
  skipExternalFileReadPermission: true,
  // 移除 ask_form / plan_to_agent（避免主动等待用户）
  useTools: ["run_shell", "search_files", "search_content", "view_file", "patch_file", "write_file", "skill", "sub_agent", "create_todo", "get_todo", "update_todo", "list_todos", "edit_notebook", "peek_bg_job", "stop_bg_job"]
})
```

### 禁用后台任务

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/project',
  disableBackgroundTasks: true,  // run_shell/sub_agent 工具的 background 字段会从 schema 中过滤
})
```

### 只允许只读操作

```javascript
// 限制可用工具，只允许读取、搜索和列表查询
const sema = new SemaCore({
  workingDir: '/path/to/project',
  useTools: ['view_file', 'search_files', 'search_content', 'get_todo', 'list_todos', 'list_crons'],
})
```

### Plan 模式（只分析不修改）

```javascript
const result = await sema.createSession({ agentMode: 'Plan' })
```

或者启动后切换至 Plan 模式：

```javascript
session.updateAgentMode('Plan')
// Plan 模式提醒会要求不修改代码，需要通过 PlanToAgent 切换到执行模式
```

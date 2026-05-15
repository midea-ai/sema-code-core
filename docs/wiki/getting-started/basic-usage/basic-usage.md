# 基础用法

## SemaCoreConfig 配置项

创建 `SemaCore` 实例时可传入以下配置：

```javascript
interface SemaCoreConfig {
  workingDir?: string;               // 项目绝对路径
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none'; // 默认 'info'
  stream?: boolean;                  // 流式输出 AI 响应，默认 否
  thinking?: boolean;                // 流式输出 AI 思考过程，默认 否
  systemPrompt?: string;             // 系统提示
  customRules?: string;              // 用户规则（内联字符串）
  skipFileEditPermission?: boolean;  // 是否跳过文件编辑权限检查，默认 否
  skipShellExecPermission?: boolean; // 是否跳过 run_shell 执行权限检查，默认 否
  skipSkillPermission?: boolean;     // 是否跳过 Skill 权限检查，默认 否
  skipMCPToolPermission?: boolean;   // 是否跳过 MCP 工具权限检查，默认 否
  skipFetchUrlPermission?: boolean;  // 是否跳过 fetch_url 权限检查，默认 否
  enableLLMCache?: boolean;          // 是否开启 LLM 缓存，默认 否（建议只在重复测试时使用）
  useTools?: string[] | null;        // 限定使用的工具，默认 null（使用所有工具）
  agentMode?: 'Agent' | 'Plan';      // 默认 'Agent'
  disableTopicDetection?: boolean;   // 是否禁用话题检测，默认 否
  disableBackgroundTasks?: boolean;  // 是否禁止后台任务（RunShell 后台 / SubAgent 后台 / 超时转后台），默认 否
}
```

> 可通过 `sema.updateCoreConfByKey(key, value)` 或 `sema.updateCoreConfig(partial)` 在运行时更新这些字段（除 `workingDir`、`logLevel`、`useTools`、`agentMode`、`disableTopicDetection` 外，其余可更新字段在 `UpdatableCoreConfigKeys` 中定义）。`useTools` 通过 `updateUseTools()` 更新；`agentMode` 通过 `updateAgentMode()` 更新。

<figure align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/system-conf.png" alt="model-list">
  <figcaption>Sema Code vscode插件页面截图</figcaption>
</figure>

## 会话生命周期

```
创建实例 → 添加模型（可跳过） → 创建会话 → 处理输入 → [中断/继续] → 释放资源
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
await sema.createSession()

// 或恢复已有会话（保留历史消息）
await sema.createSession('existing-session-id')
```

`createSession` 完成后会触发 `session:ready` 事件：

```javascript
sema.on('session:ready', ({ pid, workingDir, sessionId, historyLoaded, usage, todos, projectInputHistory, readFileTimestamps }) => {
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

> 若当前正在处理消息时再次调用 `createSession`，引擎会先中断当前请求并等待旧会话结束（最多 10 秒），再切换到新会话。

### 4. 处理用户输入

```javascript
// 非阻塞：立即返回，异步执行
sema.processUserInput('帮我优化这个函数的性能')

// 监听完成
sema.on('state:update', ({ state }) => {
  if (state === 'idle') console.log('执行完毕')
})
```

> 处理中再次调用 `processUserInput` 时，新输入会按 `command`（以 `/` 开头）/ `inject`（普通消息）类型自动入队，当前轮次结束后自动消费。`/quickchat <question>` 是旁路问答，不影响主对话状态，回复通过 `quickchat:response` 事件返回。

### 5. 中断执行

```javascript
// 可在任意时刻调用
sema.interruptSession()
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

  // 注册事件监听
  sema.on('message:text:chunk', ({ delta }) => {
    process.stdout.write(delta ?? '')
  })

  sema.on('state:update', ({ state }) => {
    if (state === 'idle') process.stdout.write('\n\n')
  })

  sema.on('tool:execution:complete', ({ toolName, summary }) => {
    console.log(`\n  ✓ [${toolName}] ${summary}`)
  })

  sema.on('tool:permission:request', ({ toolId, toolName, title }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`\n允许执行 "${title}"? (y/n): `, (answer) => {
      rl.close()
      sema.respondToToolPermission({
        toolId,    // 必传：与请求事件中的 toolId 对应，用于精确匹配
        toolName,
        selected: answer.toLowerCase() === 'y' ? 'agree' : 'refuse',
      })
    })
  })

  sema.on('session:error', ({ type, error }) => {
    console.error(`\n错误 [${type}]:`, error)
  })

  await sema.createSession()

  // REPL
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const askQuestion = () => {
    rl.question('> ', (input) => {
      if (input === '/exit') {
        sema.dispose().then(() => process.exit(0))
      } else {
        sema.processUserInput(input)
        sema.once('state:update', ({ state }) => {
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
  // 移除 ask_form / plan_to_agent（避免主动等待用户）
  useTools: ["run_shell", "search_files", "search_content", "view_file", "patch_file", "write_file", "skill", "sub_agent", "create_todo", "get_todo", "update_todo", "list_todos", "edit_notebook", "peek_bg_job", "stop_bg_job"]
})
```

### 禁用后台任务

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/project',
  disableBackgroundTasks: true,  // run_shell/sub_agent 工具的 run_in_background 字段会从 schema 中过滤
})
```

### 只允许只读操作

```javascript
// 限制可用工具，只允许读取和搜索
sema.updateUseTools(['view_file', 'search_files', 'search_content', 'run_shell', 'create_todo', 'get_todo', 'update_todo', 'list_todos'])
```

### Plan 模式（只分析不修改）

```javascript
const sema = new SemaCore({
  workingDir: '/path/to/your/project',
  agentMode: 'Plan'
})
```

或者启动后切换至Plan模式：

```javascript
sema.updateAgentMode('Plan')
// AI 只能使用只读工具，需要通过 PlanToAgent 切换到执行模式
```
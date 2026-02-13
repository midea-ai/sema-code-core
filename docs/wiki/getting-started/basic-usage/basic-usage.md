# 基础用法

## SemaCoreConfig 配置项

创建 `SemaCore` 实例时可传入以下配置：

```javascript
interface SemaCoreConfig {
  workingDir?: string;               // 项目绝对路径
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none'; // 默认 'info'
  stream?: boolean;                  // 流式输出ai响应，默认 是
  thinking?: boolean;                // 流式输出ai响应，默认 否
  systemPrompt?: string;             // 系统提示
  customRules?: string;              // 用户规则
  skipFileEditPermission?: boolean;  // 是否跳过文件编辑权限检查，默认 否
  skipBashExecPermission?: boolean;  // 是否跳过bash执行权限检查，默认 否
  skipSkillPermission?: boolean;     // 是否跳过Skill权限检查，默认 否
  skipMCPToolPermission?: boolean;   // 是否跳过MCP工具权限检查，默认 否
  enableLLMCache?: boolean;          // 是否开启LLM缓存，默认 否 建议只在重复测试时使用
  useTools?: string[] | null;        // 限定使用的工具 默认 null 使用所有工具
  agentMode?: 'Agent' | 'Plan' ;     // 默认 'Agent'
}
```

<figure align="center">
  <img src="images/system-conf.png" alt="model-list">
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
sema.on('session:ready', ({ sessionId, historyLoaded, projectInputHistory }) => {
  console.log('会话已就绪:', sessionId)
  console.log('已恢复历史:', historyLoaded)
})
```

### 4. 处理用户输入

```javascript
// 非阻塞：立即返回，异步执行
sema.processUserInput('帮我优化这个函数的性能')

// 监听完成
sema.on('state:update', ({ state }) => {
  if (state === 'idle') console.log('执行完毕')
})
```

### 5. 中断执行

```javascript
// 可在任意时刻调用
sema.interruptSession()
```

触发 `session:interrupted` 事件，当前工具调用链被取消。

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

  sema.on('tool:permission:request', ({ toolName, title }) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`\n允许执行 "${title}"? (y/n): `, (answer) => {
      rl.close()
      sema.respondToToolPermission({
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
  skipBashExecPermission: true,
  skipSkillPermission: true,
  skipMCPToolPermission: true,
  // 跳过 AskUserQuestion、ExitPlanMode
  useTools: ["Bash", "Glob", "Grep", "Read", "Edit", "Write", "Skill", "Task", "TodoWrite", "NotebookEdit"]
})
```

### 只允许只读操作

```javascript
// 限制可用工具，只允许读取和搜索
sema.updateUseTools(['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite'])
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
// AI 只能使用只读工具，需要通过 ExitPlanMode 切换到执行模式
```

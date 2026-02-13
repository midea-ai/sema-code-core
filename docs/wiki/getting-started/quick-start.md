# 快速开始

## 安装

```bash
npm install sema-core
```

**前置条件**：Node.js >= 18，以及至少一个 LLM 提供商的 API Key。

## 最简示例

```javascript
import { SemaCore } from 'sema-core'

// 1. 创建实例
const sema = new SemaCore({
  '/path/to/your/project', // 修改为你的项目路径
})

// 2. 添加模型
// 配置模型（以 DeepSeek 为例，更多提供商见"新增模型"文档）
const modelConfig = {
  provider: 'deepseek',
  modelName: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-your-api-key', // 替换为你的 API Key
  maxTokens: 8192,
  contextLength: 128000
};
const modelId = `${modelConfig.modelName}[${modelConfig.provider}]`;
await core.addModel(modelConfig);
await core.applyTaskModel({ main: modelId, quick: modelId });

// 3. 监听流式文本输出
sema.on('message:text:chunk', ({ delta }) => {
  process.stdout.write(delta ?? '')
})

// 4. 监听工具执行
sema.on('tool:execution:complete', ({ toolName, summary }) => {
  console.log(`\n[${toolName}] ${summary}`)
})

// 5. 处理权限请求
sema.on('tool:permission:request', ({ toolName }) => {
  // 自动同意（生产环境请实现交互式确认）
  sema.respondToToolPermission({ toolName, selected: 'agree' })
})

// 6. 监听完成信号
sema.on('state:update', ({ state }) => {
  if (state === 'idle') console.log('\n--- 完成 ---\n')
})

// 7. 创建会话并发送消息
await sema.createSession()
sema.processUserInput('帮我分析这个项目的代码结构')
```

## 交互式 CLI 示例

以下是一个完整的命令行对话示例（保存为 `quickstart.mjs` 并执行 `node quickstart.mjs`）：

```javascript
import { SemaCore } from 'sema-core';
import readline from 'readline';

const core = new SemaCore({
  workingDir: '/path/to/your/project', // 修改为你的项目路径
  logLevel: 'none',
  thinking: false
});

// 配置模型（以 DeepSeek 为例，更多提供商见"新增模型"文档）
const modelConfig = {
  provider: 'deepseek',
  modelName: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-your-api-key', // 替换为你的 API Key
  maxTokens: 8192,
  contextLength: 128000
};

const modelId = `${modelConfig.modelName}[${modelConfig.provider}]`;
await core.addModel(modelConfig);
await core.applyTaskModel({ main: modelId, quick: modelId });

let sessionId = null;
let rl = null;

function createRl() {
  if (rl) rl.close();
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

function prompt(question) {
  return new Promise((resolve) => {
    if (!rl) createRl();
    rl.question(question, resolve);
  });
}

const gray = (s) => `\x1b[90m${s}\x1b[0m`;
const blue = (s) => `\x1b[34m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

async function run() {
  // 创建会话
  await new Promise((resolve) => {
    core.once('session:ready', (data) => { sessionId = data.sessionId; resolve(); });
    core.createSession();
  });

  // Ctrl+C / ESC 中断
  process.on('SIGINT', () => {
    console.log('\n⚠️  中断会话...');
    if (sessionId) core.interruptSession();
    else { rl && rl.close(); process.exit(0); }
  });
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key && key.name === 'escape') core.interruptSession();
  });

  // 事件日志
  const events = [
    'tool:execution:start', 'tool:execution:complete', 'tool:execution:error',
    'task:agent:start', 'task:agent:end', 'todos:update', 'session:interrupted'
  ];
  events.forEach(e => core.on(e, (data) => console.log(gray(`${e}|${JSON.stringify(data)}`))));

  // 流式输出
  core.on('message:text:chunk', ({ delta }) => process.stdout.write(delta || ''));
  core.on('message:complete', () => process.stdout.write('\n'));

  // 权限交互
  core.on('tool:permission:request', async (data) => {
    const answer = await prompt(blue('👤 权限响应 (y=agree / a=allow / n=refuse): '));
    const map = { y: 'agree', a: 'allow', n: 'refuse' };
    core.respondToToolPermission({ toolName: data.toolName, selected: map[answer.trim()] || 'agree' });
  });

  // 对话循环
  await new Promise((resolve, reject) => {
    core.once('session:error', (data) => reject(new Error(data.message)));
    core.on('state:update', async ({ state }) => {
      if (state === 'idle') {
        setTimeout(async () => {
          const input = (await prompt(blue('\n👤 消息 (esc中断): '))).trim();
          if (input === 'exit' || input === 'quit') { resolve(); return; }
          if (input) { process.stdout.write('\n' + green('🤖 AI: ')); core.processUserInput(input); }
        }, 100);
      }
    });
    (async () => {
      const input = (await prompt(blue('👤 消息 (esc中断): '))).trim();
      if (input === 'exit' || input === 'quit') { resolve(); return; }
      if (input) { process.stdout.write('\n' + green('🤖 AI: ')); core.processUserInput(input); }
    })();
  });

  console.log('\n=== 会话结束 ===');
  rl && rl.close();
  process.exit(0);
}

run().catch((err) => { console.error('错误:', err); rl && rl.close(); process.exit(1); });
```


## 关键概念

| 概念 | 说明 | 文档 |
|------|------|------|
| **SemaCore** | 公共 API 入口，所有操作都通过它进行 | [SemaCore - 公共API层](wiki/core-concepts/core-architecture/sema-core-public-api) |
| **SemaEngine** | 核心引擎，负责协调所有子系统的初始化和运行时调度 | [SemaEngine - 业务逻辑](wiki/core-concepts/core-architecture/sema-engine-business-logic)  |
| **事件系统** | 流式输出、状态变化、工具执行均通过事件通知 | [事件总线架构](wiki/core-concepts/event-system/event-bus) |
| **工具权限** | 写操作（Bash、Edit 等）默认需要用户授权 | [权限系统](wiki/core-concepts/tool-system/permission-system) |
| **MCP** | 通过标准协议为 AI 扩展自定义工具 | [MCP 集成](wiki/core-concepts/advanced-topics/mcp-integration) |
| **Skill** | 可复用的 AI 工作流，存储为 Markdown 文件 | [Skill 支持](wiki/core-concepts/advanced-topics/skill-support) |
| **SubAgent** | 隔离执行的专用子代理 | [SubAgent 子代理](wiki/core-concepts/advanced-topics/subagents) |

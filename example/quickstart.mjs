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
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
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
    'tool:execution:start', 'tool:execution:complete', 'tool:execution:error', 'tool:permission:request',
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

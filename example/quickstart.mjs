import { SemaCore } from 'sema-core';
import readline from 'readline';

const core = new SemaCore({
  workingDir: '/path/to/your/project', // Agent 将操作的目标代码仓库路径
  logLevel: 'none',
  thinking: false,
  disableTopicDetection: true,
  disableBackgroundTasks: true,
  maxSessions: 5, // 同时最多 5 个会话
});

// 配置模型（以 qwen3.6-plus 为例，更多LLM服务商请见"新增模型"文档） 只需要加一次，后面可以注释掉添加模型相关代码
const modelConfig = {
  "modelName": "qwen3.5-plus",
  "provider": "custom",
  "baseURL": "https://aimpapi.midea.com/t-aigc/llm-openai-api",
  "apiKey": "sk-your-api-key",
  "maxTokens": 32000,
  "contextLength": 256000,
  "adapt": "openai"
};

const modelId = `${modelConfig.modelName}[${modelConfig.provider}]`;
await core.addModel(modelConfig);
await core.applyTaskModel({ main: modelId, quick: modelId });

let session = null;
let rl = null;
let interruptCount = 0; // 中断计数：第一次中断会话，第二次强制退出

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
  // 创建会话：返回 SemaSession（会话级 API 都在它上面）
  const result = await core.createSession();
  if (!result.ok) {
    console.error('创建会话失败:', result.error);
    process.exit(1);
  }
  session = result.session;

  process.on('SIGINT', () => {
    interruptCount++;
    console.log('\n⚠️  中断会话...');
    if (session && interruptCount === 1) {
      session.interrupt();
    } else {
      rl && rl.close();
      process.exit(0);
    }
  });
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key && key.name === 'escape') {
      interruptCount++;
      if (interruptCount === 1 && session) {
        session.interrupt();
      } else {
        rl && rl.close();
        process.exit(0);
      }
    }
  });

  const events = [
    'tool:execution:start', 'tool:execution:complete', 'tool:execution:error', 'tool:permission:request',
    'task:agent:start', 'task:agent:end', 'todos:update', 'session:interrupted'
  ];
  const MAX_LOG_LEN = 200;
  const truncate = (s, n = MAX_LOG_LEN) => (s.length > n ? `${s.slice(0, n)}...(${s.length - n} more)` : s);
  events.forEach(e => session.on(e, (data) => console.log(gray(`${e}|${truncate(JSON.stringify(data))}`))));

  // 流式输出
  session.on('message:text:chunk', ({ delta }) => process.stdout.write(delta || ''));
  session.on('message:complete', () => process.stdout.write('\n'));

  // 权限交互
  session.on('tool:permission:request', async (data) => {
    const answer = await prompt(blue('👤 权限响应 (y=agree / a=allow / n=refuse): '));
    const map = { y: 'agree', a: 'allow', n: 'refuse' };
    session.respondToToolPermission({ toolId: data.toolId, toolName: data.toolName, selected: map[answer.trim()] || 'agree' });
  });

  // 对话循环
  await new Promise((resolve, reject) => {
    session.once('session:error', (data) => reject(new Error(data.message)));
    session.on('state:update', async ({ state }) => {
      if (state === 'processing') interruptCount = 0; // 恢复运行后重置中断计数
      if (state === 'idle') {
        setTimeout(async () => {
          const input = (await prompt(blue('\n👤 消息 (esc中断): '))).trim();
          if (input === 'exit' || input === 'quit') { resolve(); return; }
          if (input) { process.stdout.write('\n' + green('🤖 AI: ')); session.processUserInput(input); }
        }, 100);
      }
    });
    (async () => {
      const input = (await prompt(blue('👤 消息 (esc中断): '))).trim();
      if (input === 'exit' || input === 'quit') { resolve(); return; }
      if (input) { process.stdout.write('\n' + green('🤖 AI: ')); session.processUserInput(input); }
    })();
  });

  console.log('\n=== 会话结束 ===');
  core.closeSession(session.sessionId);
  await core.dispose();
  rl && rl.close();
  process.exit(0);
}

run().catch((err) => { console.error('错误:', err); rl && rl.close(); process.exit(1); });

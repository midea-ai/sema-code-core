/**
 * 入口 1：交互式 CLI
 *
 * 用法：
 *   npm run cli /path/to/project           # 指定项目目录（必填），新建会话
 *   npm run cli /path/to/project <会话id>   # 指定目录 + 加载历史会话
 *
 * 模型自动读取 ~/.sema/model.conf（见 README），代码里无需配置模型。
 */
import { SemaCore } from 'sema-core';
import type { SemaSession } from 'sema-core';
import { MAIN_AGENT_ID } from 'sema-core/types';
import readline from 'node:readline';
import fs from 'node:fs';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const workingDir = positional[0];
const resumeSessionId = positional[1];
if (!workingDir) {
  console.error('用法: npm run cli <项目目录> [会话id]');
  process.exit(1);
}
if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) {
  console.error(`项目目录不存在或不是目录: ${workingDir}`);
  process.exit(1);
}

const core = new SemaCore({
  workingDir,
  logLevel: 'none',
  thinking: true,
  disableTopicDetection: true,
  disableBackgroundTasks: true,
  disabledTools: ['ask_form', 'plan_to_agent'],
});

let session: SemaSession | null = null;
let rl: readline.Interface | null = null;
let interruptCount = 0; // 第一次中断会话，第二次强制退出

function createRl(): readline.Interface {
  if (rl) rl.close();
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  return rl;
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    if (!rl) createRl();
    rl!.question(question, resolve);
  });
}

const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
const blue = (s: string) => `\x1b[34m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

async function run(): Promise<void> {
  // 创建/加载会话：返回 SemaSession（会话级 API 都在它上面）
  const result = await core.createSession(resumeSessionId ? { sessionId: resumeSessionId } : {});
  if (!result.ok) {
    console.error('创建会话失败:', result.error);
    process.exit(1);
  }
  session = result.session;
  console.log(green(`会话id: ${session.sessionId}`) + gray(resumeSessionId ? ' (已加载历史会话)' : ' (新建会话)'));

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
  process.stdin.on('keypress', (_str: string, key: readline.Key) => {
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

  // 工具/任务事件：仅打印标题（截断超长内容）
  const MAX_LOG_LEN = 200;
  const truncate = (s: string, n = MAX_LOG_LEN) =>
    s.length > n ? `${s.slice(0, n)}...(${s.length - n} more)` : s;
  const logEvents = [
    'tool:execution:complete',
    'tool:execution:error',
    'tool:permission:request',
    'task:agent:start',
    'task:agent:end',
    'todos:update',
    'session:interrupted',
  ];
  logEvents.forEach((e) =>
    session!.on(e, (data: unknown) => console.log(gray(`${e}|${truncate(JSON.stringify(data))}`)))
  );

  // 子代理深度跟踪：message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断是否在子代理内
  const isMain = (agentId?: string) => agentId === MAIN_AGENT_ID || !agentId;
  let subAgentDepth = 0;
  session.on('task:agent:start', () => { subAgentDepth++; });
  session.on('task:agent:end', () => { if (subAgentDepth > 0) subAgentDepth--; });

  // 流式输出：仅主代理，避免子代理文本混入主输出
  session.on('message:text:chunk', ({ delta }: { delta: string }) => {
    if (subAgentDepth > 0 || !delta) return;
    process.stdout.write(delta);
  });
  session.on('message:complete', (d: { agentId?: string }) => {
    if (isMain(d.agentId)) process.stdout.write('\n');
  });

  // 权限交互
  session.on('tool:permission:request', async (data: { toolId: string; toolName: string }) => {
    const answer = await prompt(blue('👤 权限响应 (y=agree / n=refuse): '));
    const map: Record<string, string> = { y: 'agree', n: 'refuse' };
    session!.respondToToolPermission({
      toolId: data.toolId,
      toolName: data.toolName,
      selected: map[answer.trim()] || 'agree',
    });
  });

  // 恢复运行后重置中断计数（仅用于中断计数，不再用 idle 驱动对话循环）
  session.on('state:update', ({ state }: { state: string }) => {
    if (state === 'processing') interruptCount = 0;
  });

  // 对话循环：以主代理回到 idle 作为一轮结束信号
  await new Promise<void>((resolve, reject) => {
    let awaitingInput = false; // 防止重复弹出输入

    const askAndSend = async (): Promise<void> => {
      if (awaitingInput) return;
      awaitingInput = true;
      const input = (await prompt(blue('\n👤 消息 (esc中断): '))).trim();
      awaitingInput = false;
      if (input === 'exit' || input === 'quit') {
        resolve();
        return;
      }
      if (!input) {
        askAndSend(); // 空输入：重新询问
        return;
      }
      process.stdout.write('\n' + green('🤖 AI: '));
      interruptCount = 0;
      session!.processUserInput(input);
    };

    session!.once('session:error', (data: { message: string }) => reject(new Error(data.message)));
    session!.on('state:update', ({ state }: { state: string }) => { if (state === 'idle') askAndSend(); });
    session!.on('session:interrupted', () => askAndSend());
    // 会话初始即 idle 不会触发 state:update，故靠 session:ready 弹首条输入
    session!.once('session:ready', () => askAndSend());
  });

  console.log('\n=== 会话结束 ===');
  core.closeSession(session.sessionId);
  await core.dispose();
  rl && rl.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('错误:', err);
  rl && rl.close();
  process.exit(1);
});

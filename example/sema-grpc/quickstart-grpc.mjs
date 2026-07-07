/**
 * sema-grpc 快速上手示例（单会话）
 *
 * 依赖：
 *   npm install @grpc/grpc-js @grpc/proto-loader readline
 *
 * 启动前请先运行 sema-grpc 服务：
 *   cd sema-grpc && npm install && npm run build && npm start
 *
 * 运行：
 *   node quickstart-grpc.mjs
 *
 * ── 协议要点（与旧版的差异）──────────────────────────────────────────────────
 * 桥现在是 sema-core 的透明镜像：action 名与 sema-core 方法名一一对应
 * （init / createSession / processUserInput / interrupt / addModel …），事件名保持 core 原始名。
 * BridgeCommand/BridgeEvent 新增 session_id 字段：
 *   - session_id 为空  → 调用进程级 SemaCore 方法（init / addModel / createSession …）
 *   - session_id 非空  → 路由到对应会话的 SemaSession 方法（processUserInput / interrupt …）
 * createSession 的 ack 直接回 { sessionId }；session:ready 事件也带同一个 id。
 * 本示例只用一个会话，把它记在 sessionId 里，会话级指令统一带上。
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import readline from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';

// ── 配置 ────────────────────────────────────────────────────────────────────

const GRPC_HOST = 'localhost:3766';

const WORKING_DIR = '/path/to/your/project'; // Agent 将操作的目标代码仓库路径

// 配置模型（以 deepseek 为例，更多LLM服务商请见"新增模型"文档）
// 只需要加一次，后面可以注释掉添加模型相关代码
const MODEL_CONFIG  = {
  "modelName": "deepseek-v4-flash",
  "provider": "deepseek",
  "baseURL": "https://api.deepseek.com/anthropic",
  "apiKey": "sk-your-api-key",  // 替换为你的 API Key
  "maxTokens": 32000,
  "contextLength": 256000,
  "adapt": "anthropic"
};

// ── Proto 加载 ───────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, 'proto', 'sema.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto = grpc.loadPackageDefinition(packageDef);
const SemaBridge = proto.sema.SemaBridge;

// ── 颜色工具 ─────────────────────────────────────────────────────────────────

const gray  = (s) => `\x1b[90m${s}\x1b[0m`;
const blue  = (s) => `\x1b[34m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

// ── readline ─────────────────────────────────────────────────────────────────

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

// ── ID 生成 ───────────────────────────────────────────────────────────────────

let _seq = 0;
const nextId = () => `cmd-${++_seq}`;

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

async function run() {
  // 建立 gRPC 双向流连接
  const client = new SemaBridge(GRPC_HOST, grpc.credentials.createInsecure());
  const call = client.Connect();

  // 发送指令的辅助函数。
  // sessionId 为会话级指令的目标会话；进程级指令（init / addModel / createSession …）留空即可。
  function send(action, payload, sessionId = '') {
    const id = nextId();
    call.write({
      id,
      action,
      payload: payload !== undefined ? JSON.stringify(payload) : '',
      session_id: sessionId,
    });
    return id;
  }

  // ── 等待指定 cmdId 的 ack（确保命令按序完成），resolve 出 ack 携带的 data ──────
  const waitForAck = (cmdId) =>
    new Promise((resolve, reject) => {
      const handler = (msg) => {
        if (msg.cmd_id === cmdId) {
          off();
          const parsed = msg.data ? JSON.parse(msg.data) : undefined;
          if (msg.event === 'ack') {
            resolve(parsed);
          } else if (msg.event === 'error') {
            reject(new Error(parsed?.message || 'Command failed'));
          }
        }
      };
      call.on('data', handler);
      const off = () => call.removeListener('data', handler);
    });

  async function sendAndWait(action, payload, sessionId = '') {
    const id = send(action, payload, sessionId);
    return waitForAck(id);
  }

  // ── 状态机 ────────────────────────────────────────────────────────────────

  let sessionId = null;
  let state = 'init'; // init | idle | processing
  let interruptCount = 0; // 中断计数：第一次中断会话，第二次强制退出
  let subAgentDepth = 0;  // 子代理深度：>0 时不把文本混入主输出
  let awaitingInput = false; // 防止多个结束信号重复弹出输入
  let finished = false;
  let resolveRun;
  const done = new Promise((resolve) => { resolveRun = resolve; });

  // message:text:chunk 不带 agentId，靠 task:agent:start/end 包裹判断是否在子代理内
  const MAIN_AGENT_ID = 'main';
  const isMain = (agentId) => agentId === MAIN_AGENT_ID || !agentId;

  // 弹出输入并发送。以主代理回到 idle 作为弹出时机。
  async function askAndSend() {
    if (awaitingInput || finished) return;
    awaitingInput = true;
    const input = (await prompt(blue('\n👤 消息 (esc中断): '))).trim();
    awaitingInput = false;
    if (input === 'exit' || input === 'quit') { finished = true; resolveRun(); return; }
    if (!input) { askAndSend(); return; } // 空输入：重新询问
    process.stdout.write('\n' + green('🤖 AI: '));
    interruptCount = 0;
    send('processUserInput', { content: input }, sessionId);
  }

  // 统一处理所有服务端推送事件（仅此一个 data 主分发器，避免重复注册）
  call.on('data', (msg) => {
    const { event, data } = msg;
    const parsed = data ? JSON.parse(data) : undefined;

    switch (event) {
      // 调试日志（灰色）
      case 'tool:execution:complete':
      case 'tool:execution:error':
      case 'task:start':
      case 'task:end':
      case 'todos:update':
        console.log(gray(`${event}|${data}`));
        break;

      // 子代理进入/退出
      case 'task:agent:start':
        subAgentDepth++;
        console.log(gray(`${event}|${data}`));
        break;
      case 'task:agent:end':
        if (subAgentDepth > 0) subAgentDepth--;
        console.log(gray(`${event}|${data}`));
        break;

      // 会话就绪 → 记下 sessionId 并弹首条输入
      case 'session:ready':
        sessionId = parsed?.sessionId ?? msg.session_id;
        state = 'idle';
        askAndSend();
        break;

      // 被中断后重新弹输入
      case 'session:interrupted':
        console.log(gray(`${event}|${data}`));
        askAndSend();
        break;

      // 状态变化：回到 idle 即一轮结束，弹下一条输入
      case 'state:update':
        state = parsed?.state ?? state;
        if (state === 'processing') interruptCount = 0; // 恢复运行后重置中断计数
        if (state === 'idle') askAndSend();
        break;

      // AI 流式文本：仅主代理，避免子代理文本混入主输出
      case 'message:text:chunk':
        if (subAgentDepth === 0) process.stdout.write(parsed?.delta || '');
        break;

      // AI 输出完成：仅主代理换行
      case 'message:complete':
        if (isMain(parsed?.agentId)) process.stdout.write('\n');
        break;

      // 工具权限请求（异步处理）
      case 'tool:permission:request':
        console.log(gray(`${event}|${data}`));
        handlePermission(parsed);
        break;

      // 选项询问 / 计划退出：本示例未实现交互应答，仅记录（如触发需自行响应）
      case 'pick:option:request':
      case 'plan:exit:request':
        console.log(gray(`${event}|${data}`));
        break;

      // 错误
      case 'error':
        console.error(`\n[error] ${parsed?.message}`);
        break;

      default:
        break;
    }
  });

  call.on('error', (err) => {
    console.error('[gRPC] 连接错误:', err.message);
    process.exit(1);
  });

  call.on('end', () => {
    console.log('\n=== 连接已关闭 ===');
    rl && rl.close();
    process.exit(0);
  });

  // ── 权限响应处理 ──────────────────────────────────────────────────────────

  async function handlePermission(data) {
    const answer = await prompt(blue('👤 权限响应 (y=agree / a=allow / n=refuse): '));
    const map = { y: 'agree', a: 'allow', n: 'refuse' };
    send('respondToToolPermission', {
      toolId: data?.toolId,
      toolName: data?.toolName,
      selected: map[answer.trim()] || 'agree',
    }, sessionId);
  }

  // ── Ctrl+C / ESC 中断 ─────────────────────────────────────────────────────

  process.on('SIGINT', () => {
    interruptCount++;
    console.log('\n⚠️  中断会话...');
    if (sessionId && interruptCount === 1) {
      send('interrupt', undefined, sessionId);
    } else {
      rl && rl.close();
      call.end();
      process.exit(0);
    }
  });

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key && key.name === 'escape') {
      interruptCount++;
      if (interruptCount === 1 && sessionId) {
        send('interrupt', undefined, sessionId);
      } else {
        rl && rl.close();
        call.end();
        process.exit(0);
      }
    }
  });

  // ── 初始化：init（进程级，非破坏式，仅首次建 Core 时吃 payload）─────────────

  await sendAndWait('init', { workingDir: WORKING_DIR, logLevel: 'none', thinking: false, disableBackgroundTasks: true, disableTopicDetection: true, disabledTools: ['ask_form', 'plan_to_agent'] });

  // ── 添加并应用模型（进程级）──────────────────────────────────────────────

  await sendAndWait('addModel', { config: MODEL_CONFIG });
  const modelId = `${MODEL_CONFIG.modelName}[${MODEL_CONFIG.provider}]`;
  await sendAndWait('applyTaskModel', { main: modelId, quick: modelId });
  console.log(`Model configured: ${modelId}`);

  // ── 创建会话（进程级，ack 回 { sessionId }）────────────────────────────────
  // 这里同时演示两种取 sessionId 的方式：ack 直接回、以及随后到达的 session:ready 事件。
  // 就绪后由主分发器的 session:ready 分支弹首条输入，随后由 state:update=idle 驱动对话循环。

  const created = await sendAndWait('createSession');
  sessionId = created?.sessionId ?? sessionId;

  // ── 对话循环：等待用户 exit/quit ──────────────────────────────────────────

  await done;

  // ── 退出：关闭会话（会话级，需带 sessionId）────────────────────────────────

  console.log('\n=== 会话结束 ===');
  if (sessionId) send('closeSession', undefined, sessionId);
  call.end();
  rl && rl.close();
}

run().catch((err) => {
  console.error('错误:', err);
  rl && rl.close();
  process.exit(1);
});

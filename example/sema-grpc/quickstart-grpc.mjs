/**
 * sema-grpc 快速上手示例
 *
 * 依赖：
 *   npm install @grpc/grpc-js @grpc/proto-loader readline
 *
 * 启动前请先运行 sema-grpc 服务：
 *   cd sema-grpc && npm start
 *
 * 运行：
 *   node quickstart-grpc.mjs
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import readline from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';

// ── 配置 ────────────────────────────────────────────────────────────────────

const GRPC_HOST = 'localhost:3766';

const WORKING_DIR = '/path/to/your/project'; // Agent 将操作的目标代码仓库路径

// 配置模型（以 qwen3.6-plus 为例，更多LLM服务商请见"新增模型"文档）
// 只需要加一次，后面可以注释掉添加模型相关代码
const MODEL_CONFIG = {
  provider: "custom",
  modelName: "qwen3.5-plus",
  baseURL: "https://aimpapi.midea.com/t-aigc/llm-openai-api",
  apiKey: "sk-",
  maxTokens: 32000,
  contextLength: 256000,
  adapt: "openai"
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

  // 发送指令的辅助函数
  function send(action, payload) {
    const id = nextId();
    call.write({
      id,
      action,
      payload: payload !== undefined ? JSON.stringify(payload) : '',
    });
    return id;
  }

  // ── 等待特定事件的 Promise 工厂 ───────────────────────────────────────────
  const waitFor = (eventName) =>
    new Promise((resolve) => {
      const handler = (msg) => {
        if (msg.event === eventName) {
          off();
          resolve(msg.data ? JSON.parse(msg.data) : undefined);
        }
      };
      call.on('data', handler);
      const off = () => call.removeListener('data', handler);
    });

  // ── 等待指定 cmdId 的 ack（确保命令按序完成）────────────────────────────
  const waitForAck = (cmdId) =>
    new Promise((resolve, reject) => {
      const handler = (msg) => {
        if (msg.cmd_id === cmdId) {
          off();
          if (msg.event === 'ack') {
            resolve();
          } else if (msg.event === 'error') {
            const parsed = msg.data ? JSON.parse(msg.data) : {};
            reject(new Error(parsed.message || 'Command failed'));
          }
        }
      };
      call.on('data', handler);
      const off = () => call.removeListener('data', handler);
    });

  async function sendAndWait(action, payload) {
    const id = send(action, payload);
    await waitForAck(id);
  }

  // ── 状态机 ────────────────────────────────────────────────────────────────

  let sessionId = null;
  let state = 'init'; // init | idle | running
  let interruptCount = 0; // 中断计数：第一次中断会话，第二次强制退出

  // 统一处理所有服务端推送事件
  call.on('data', (msg) => {
    const { event, data, cmd_id } = msg;
    const parsed = data ? JSON.parse(data) : undefined;

    switch (event) {
      // 调试日志（灰色）
      case 'tool:execution:start':
      case 'tool:execution:complete':
      case 'tool:execution:error':
      case 'task:agent:start':
      case 'task:agent:end':
      case 'todos:update':
      case 'session:interrupted':
        console.log(gray(`${event}|${data}`));
        break;

      // 会话就绪
      case 'session:ready':
        sessionId = parsed?.sessionId;
        state = 'idle';
        break;

      // 状态变化
      case 'state:update':
        state = parsed?.state ?? state;
        if (state === 'running') interruptCount = 0; // 恢复运行后重置中断计数
        break;

      // AI 流式文本
      case 'message:text:chunk':
        process.stdout.write(parsed?.delta || '');
        break;

      // AI 输出完成
      case 'message:complete':
        process.stdout.write('\n');
        break;

      // 工具权限请求（异步处理）
      case 'tool:permission:request':
        console.log(gray(`${event}|${data}`));
        handlePermission(parsed);
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
    send('permission.respond', {
      toolId: data?.toolId,
      toolName: data?.toolName,
      selected: map[answer.trim()] || 'agree',
    });
  }

  // ── Ctrl+C / ESC 中断 ─────────────────────────────────────────────────────

  process.on('SIGINT', () => {
    interruptCount++;
    console.log('\n⚠️  中断会话...');
    if (sessionId && interruptCount === 1) {
      send('session.interrupt');
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
        send('session.interrupt');
      } else {
        rl && rl.close();
        call.end();
        process.exit(0);
      }
    }
  });

  // ── 初始化：config.init ───────────────────────────────────────────────────

  await sendAndWait('config.init', { workingDir: WORKING_DIR, logLevel: 'none', thinking: false, disableBackgroundTasks: true, disableTopicDetection: true });

  // ── 添加并应用模型 ────────────────────────────────────────────────────────

  await sendAndWait('model.add', { config: MODEL_CONFIG });
  const modelId = `${MODEL_CONFIG.modelName}[${MODEL_CONFIG.provider}]`;
  await sendAndWait('model.applyTask', { main: modelId, quick: modelId });
  console.log(`Model configured: ${modelId}`);

  // ── 创建会话，等待 session:ready ──────────────────────────────────────────

  send('session.create');
  await waitFor('session:ready');
  console.log(`[session] sessionId=${sessionId}`);

  // ── 对话循环 ──────────────────────────────────────────────────────────────

  await new Promise((resolve, reject) => {
    call.on('data', async (msg) => {
      if (msg.event === 'state:update') {
        const s = msg.data ? JSON.parse(msg.data) : {};
        if (s.state === 'idle') {
          setTimeout(async () => {
            const input = (await prompt(blue('\n👤 消息 (esc中断): '))).trim();
            if (input === 'exit' || input === 'quit') { resolve(); return; }
            if (input) { process.stdout.write('\n' + green('🤖 AI: ')); send('session.input', { content: input }); }
          }, 100);
        }
      }
    });
    (async () => {
      const input = (await prompt(blue('👤 消息 (esc中断): '))).trim();
      if (input === 'exit' || input === 'quit') { resolve(); return; }
      if (input) { process.stdout.write('\n' + green('🤖 AI: ')); send('session.input', { content: input }); }
    })();
  });

  // ── 退出 ──────────────────────────────────────────────────────────────────

  console.log('\n=== 会话结束 ===');
  send('session.dispose');
  call.end();
  rl && rl.close();
}

run().catch((err) => {
  console.error('错误:', err);
  rl && rl.close();
  process.exit(1);
});

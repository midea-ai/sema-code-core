/**
 * sema-code-ui 命令行入口（npm 包，bin/sema-code-ui.js 加载 dist/cli.js）。
 *
 *   sema-code-ui start [--port 3210] [--token xxx] [--no-open]   前台启动，默认打开浏览器；已在运行则只打开页面
 *                                                                终端只打必读的几句；内部错误进 ~/.sema/webui/error.log，core 日志在 ~/.sema/logs/
 *   sema-code-ui status                                         运行状态：端口 / 地址 / 版本 / pid
 *   sema-code-ui open                                            只打开页面，不重复起服务
 *   sema-code-ui stop                                            结束运行中的实例
 *
 * 实例检测：启动时写 ~/.sema/webui/run.json（pid/port/url/version/startedAt），退出时删除；
 * 真正判定以 GET /api/health 为准（返回 name=semawork 才算本服务），记录残留而接口不通视为僵尸记录清掉。
 * 服务本体与 npm start / 桌面版共用 webui/server/src/server.ts。
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WEBUI_HOME } from '../../server/src/registry/registry';
import { openExternal } from '../../server/src/http/router';
import { startServer, type ServerHandle } from '../../server/src/server';
import { arg, loadOrCreateToken } from '../../server/src/cliUtil';
import { initErrorLog, installProcessTraps } from '../../server/src/errlog';

// 同 server/src/index.ts：core worker 是线程，共用进程的 libuv 线程池，缺省 4 放宽到 16；须早于任何异步 fs 调用
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

const { version: VERSION } = require('../package.json') as { version: string };
const HOST = '127.0.0.1';
const RUN_FILE = path.join(WEBUI_HOME, 'run.json');
const PROBE_TIMEOUT_MS = 1000;
const STOP_WAIT_MS = 10_000;

interface RunRecord { pid: number; port: number; url: string; version: string; startedAt: string }
interface Health { name: string; version: string | null; pid: number }
interface Running { port: number; url: string; version: string | null; pid: number; startedAt?: string }

const HELP = `sema-code-ui ${VERSION}

用法：
  sema-code-ui start [--port 3210] [--token xxx] [--no-open]   启动服务并打开浏览器（已在运行则只打开页面）
  sema-code-ui status                                         查看运行状态
  sema-code-ui open                                            打开页面，不重复起服务
  sema-code-ui stop                                            结束运行中的实例
  sema-code-ui --version

Ctrl+C 或关闭终端即停止服务，正在运行的任务会被中断。数据目录 ~/.sema/webui/，错误日志 ~/.sema/webui/error.log。`;

// ---- 运行记录 ----

function readRecord(): RunRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
    return r && typeof r.port === 'number' && typeof r.url === 'string' ? r : null;
  } catch { return null; }
}
function writeRecord(r: RunRecord) {
  try { fs.mkdirSync(WEBUI_HOME, { recursive: true }); fs.writeFileSync(RUN_FILE, JSON.stringify(r, null, 2), { mode: 0o600 }); } catch (e: any) { console.warn('[run] 运行记录写入失败：', e?.message); }
}
function removeRecord() { try { fs.unlinkSync(RUN_FILE); } catch { /* 不存在 */ } }

/** 探测端口上是否是本服务（免 token 的健康接口），超时或非本服务返回 null */
function probe(port: number): Promise<Health | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/health', timeout: PROBE_TIMEOUT_MS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { const j = JSON.parse(body); resolve(j && j.name === 'semawork' ? j : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/** 先按运行记录找，再探测给定端口（兜住 webui/ 里 npm start 起的开发实例，它不写记录） */
async function findRunning(port?: number): Promise<Running | null> {
  const rec = readRecord();
  if (rec) {
    const h = await probe(rec.port);
    if (h) return { port: rec.port, url: rec.url, version: h.version, pid: h.pid, startedAt: rec.startedAt };
    removeRecord();
  }
  if (port) {
    const h = await probe(port);
    if (h) return { port, url: `http://${HOST}:${port}/?token=${loadOrCreateToken()}`, version: h.version, pid: h.pid };
  }
  return null;
}

function describe(r: Running): string {
  const lines = [`地址    ${r.url}`, `端口    ${r.port}`, `版本    ${r.version || '未知'}`, `pid     ${r.pid}`];
  if (r.startedAt) lines.push(`启动于  ${new Date(r.startedAt).toLocaleString()}`);
  return lines.join('\n');
}

function open(url: string) {
  return openExternal(url).catch((e: any) => console.warn('打开浏览器失败，请手动访问：', e?.message || e));
}

// ---- 子命令 ----

async function start() {
  const port = Number(arg('port', process.env.PORT || '3210'));
  const noOpen = arg('no-open') === 'true';

  const running = await findRunning(port);
  if (running) {
    console.log(`SemaWork 已在运行，不重复启动。\n${describe(running)}`);
    if (running.version && running.version !== VERSION) console.log(`\n注意：运行中的版本 ${running.version} 与当前命令 ${VERSION} 不一致，可先 sema-code-ui stop 再 start。`);
    if (!noOpen) await open(running.url);
    return;
  }

  const token = arg('token') || process.env.SEMA_WEBUI_TOKEN || loadOrCreateToken();
  let handle: ServerHandle | null = null;
  let closing = false;
  let closingAt = 0;
  async function shutdown() {
    if (closing) {
      // npm/npx 等父进程会把终端信号再转发一次，1 秒内的重复信号视为同一次 Ctrl+C，不打断优雅关闭
      if (Date.now() - closingAt < 1000) return;
      console.log('\n再次收到信号，强制退出');
      removeRecord();
      process.exit(1);
    }
    closing = true;
    closingAt = Date.now();
    console.log('\n正在关闭…');
    await handle?.close();
    removeRecord();
    process.exit(0);
  }
  // 终端只留必读的几句，内部错误与兜底异常进 ~/.sema/webui/error.log（每次启动清空）
  initErrorLog('cli', VERSION);
  installProcessTraps('server');
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.on('exit', removeRecord);

  try {
    handle = await startServer({ port, host: HOST, token, version: VERSION });
  } catch (e: any) {
    console.error(e?.message || e);
    process.exit(1);
  }
  writeRecord({ pid: process.pid, port: handle.port, url: handle.url, version: VERSION, startedAt: new Date().toISOString() });
  console.log(`\nSemaWork ${VERSION} 已启动：${handle.url}\n按 Ctrl+C 停止。\n`);
  if (!noOpen) await open(handle.url);
}

async function status() {
  const running = await findRunning(Number(arg('port', process.env.PORT || '3210')));
  if (!running) { console.log('SemaWork 未运行。启动：sema-code-ui start'); return; }
  console.log(`SemaWork 运行中\n${describe(running)}`);
}

async function openPage() {
  const running = await findRunning(Number(arg('port', process.env.PORT || '3210')));
  if (!running) { console.error('SemaWork 未运行，请先 sema-code-ui start'); process.exit(1); }
  await open(running.url);
  console.log(`已打开 ${running.url}`);
}

async function stop() {
  const running = await findRunning(Number(arg('port', process.env.PORT || '3210')));
  if (!running) { console.log('SemaWork 未运行。'); return; }
  try { process.kill(running.pid, 'SIGTERM'); } catch (e: any) { console.error(`结束进程 ${running.pid} 失败：`, e?.message || e); process.exit(1); }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await probe(running.port))) { removeRecord(); console.log(`SemaWork 已停止（pid ${running.pid}）`); return; }
  }
  console.error(`已发送停止信号，但 ${STOP_WAIT_MS / 1000} 秒内服务仍在响应，请检查进程 ${running.pid}`);
  process.exit(1);
}

// ---- 入口 ----

const cmd = process.argv[2];
const run: Record<string, () => Promise<void>> = { start, status, open: openPage, stop };
if (cmd === '--version' || cmd === '-v') {
  console.log(VERSION);
} else if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(HELP);
} else if (run[cmd]) {
  run[cmd]().catch((e: any) => { console.error(e?.message || e); process.exit(1); });
} else {
  console.error(`未知命令：${cmd}\n\n${HELP}`);
  process.exit(1);
}

/**
 * server 宿主：utility 子进程入口。加载同目录的 server.js 起 webui/server，把句柄的几个方法经 parentPort 暴露给主进程。
 * 协议：
 *   子→主  { type:'ready', host, port, token, url } | { type:'error', message } | { id, ok, data|error }
 *   主→子  { id, type: 'preventSleepMode' | 'hasActiveWork' | 'close' }
 * 端口与 token 由 env SEMA_DESKTOP_PORT / SEMA_DESKTOP_TOKEN 传入。
 * worker 从这里 fork：本进程没有窗口，CreateProcess 不会卡住界面，Windows 的"启动中"转圈光标也不会出现在主窗口上。
 */
import path from 'path';
import { logErr } from '../../webui/server/src/errlog';

interface ServerHandle {
  host: string; port: number; token: string; url: string;
  close(): Promise<void>;
  preventSleepMode(): 'off' | 'ac' | 'always';
  hasActiveWork(): Promise<boolean>;
}
interface ServerModule { startServer(opts: { port: number; host?: string; token: string }): Promise<ServerHandle> }
/** utility 进程里的 process.parentPort（Electron.ParentPort），这里只用到两个成员 */
interface ParentPort {
  on(event: 'message', listener: (e: { data: any }) => void): void;
  postMessage(message: any): void;
}

const port = (process as any).parentPort as ParentPort;
const SERVER_ENTRY = path.join(__dirname, 'server.js');

let handle: ServerHandle | null = null;

/** 启动失败：告诉主进程后退出（留一拍让消息送达），否则主进程会一直等 ready */
function fail(err: any): void {
  port.postMessage({ type: 'error', message: err?.message || String(err) });
  setTimeout(() => process.exit(1), 50);
}

// 启动阶段（还没 ready）的未捕获异常必须让主进程知道，否则窗口永远开不出来；
// 启动后与 CLI 入口一致：只记 error.log（主进程已在 fork 前清空重建），不让 server（含所有 worker/终端）崩掉
process.on('uncaughtException', (err) => {
  logErr('server-host', 'uncaughtException:', err);
  if (!handle) fail(err);
});
process.on('unhandledRejection', (reason) => { logErr('server-host', 'unhandledRejection:', reason); });

port.on('message', async (e) => {
  const m = e.data;
  if (!m || typeof m.id !== 'number') return;
  try {
    if (!handle) throw new Error('server not started');
    let data: unknown;
    switch (m.type) {
      case 'preventSleepMode': data = handle.preventSleepMode(); break;
      case 'hasActiveWork': data = await handle.hasActiveWork(); break;
      case 'close': await handle.close(); handle = null; data = true; break;
      default: throw new Error(`unknown request: ${m.type}`);
    }
    port.postMessage({ id: m.id, ok: true, data });
    // 应答发出后再退出，留一拍让消息送达；主进程侧收不到应答也会等 exit 事件
    if (m.type === 'close') setTimeout(() => process.exit(0), 50);
  } catch (err: any) {
    port.postMessage({ id: m.id, ok: false, error: err?.message || String(err) });
  }
});

// 加载 server 模块与 startServer 里的同步构造（注册表读取等）都可能直接抛：一并兜住，不能让子进程活着却不吭声
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startServer } = require(SERVER_ENTRY) as ServerModule;
  startServer({ port: Number(process.env.SEMA_DESKTOP_PORT || 0), host: '127.0.0.1', token: process.env.SEMA_DESKTOP_TOKEN || '' })
    .then((h) => {
      handle = h;
      port.postMessage({ type: 'ready', host: h.host, port: h.port, token: h.token, url: h.url });
    })
    .catch(fail);
} catch (err) {
  fail(err);
}

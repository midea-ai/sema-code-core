/**
 * SemaWork 服务端入口。
 *   node dist/index.js --port 3210 [--host 127.0.0.1] [--open] [--token xxx]
 * 只监听 loopback；token 优先级 --token > SEMA_WEBUI_TOKEN > ~/.sema/webui/token（首次随机生成后持久化，
 * 重启复用，已打开的页面才能自动重连），REST/WS 必须携带。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { WebSocketServer } from 'ws';
import { RegistryStore, WEBUI_HOME } from './registry/registry';
import { SessionManager } from './sessions';
import { Router, json, openExternal, sendFile } from './http/router';
import { attachWs } from './ws/handler';
import { TerminalManager } from './terminal/manager';
import { attachTermWs } from './ws/terminal';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : 'true';
  return def;
}

const port = Number(arg('port', process.env.PORT || '3210'));
const host = arg('host', '127.0.0.1')!;
const token = arg('token') || process.env.SEMA_WEBUI_TOKEN || loadOrCreateToken();

/** 持久化 token：随机 token 每次启动都变会让已打开页面的重连永远被拒，这里落盘复用 */
function loadOrCreateToken(): string {
  const file = path.join(WEBUI_HOME, 'token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(t)) return t;
  } catch { /* 不存在或不可读则重新生成 */ }
  const t = randomBytes(16).toString('hex');
  try { fs.mkdirSync(WEBUI_HOME, { recursive: true }); fs.writeFileSync(file, t, { mode: 0o600 }); } catch (e: any) { console.warn('[token] 持久化失败，本次使用临时 token:', e?.message); }
  return t;
}
const shouldOpen = arg('open') === 'true';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK.has(host)) {
  console.error(`拒绝启动：当前阶段仅支持 loopback 监听（--host ${host}）`);
  process.exit(1);
}

const entryPath = path.join(__dirname, 'worker-entry.js');
if (!fs.existsSync(entryPath)) {
  console.error(`找不到 worker 入口 ${entryPath}，请先执行 npm run build`);
  process.exit(1);
}

const registry = new RegistryStore();
const sm = new SessionManager(registry, entryPath);
const tm = new TerminalManager();
sm.killTerminals = (sid) => tm.killBySession(sid);
const router = new Router(sm, tm);

// 静态资源：client 构建产物
const CLIENT_DIST = [path.join(__dirname, '..', '..', 'client', 'dist'), path.join(__dirname, 'public')].find(p => fs.existsSync(path.join(p, 'index.html')));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
};

function authorized(req: http.IncomingMessage, url: URL): boolean {
  const h = req.headers.authorization;
  if (h && h === `Bearer ${token}`) return true;
  return url.searchParams.get('token') === token;
}

// 本地文件代理：右栏浏览器内嵌 file:// 页面用（iframe 无法直接加载 file://）。
// 形如 /api/local/<token>/<绝对路径>：token 嵌在路径前缀，页面内相对资源解析后仍落在该前缀下，
// 因此 iframe 可用无 allow-same-origin 的沙箱（不透明源，防内嵌页脚本借同源偷 token 调 API）
const LOCAL_MIME: Record<string, string> = {
  ...MIME, '.htm': 'text/html; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};
function serveLocalFile(res: http.ServerResponse, pathname: string) {
  const rest = pathname.slice('/api/local/'.length);
  const slash = rest.indexOf('/');
  const tok = decodeURIComponent(slash >= 0 ? rest.slice(0, slash) : rest);
  if (tok !== token) { json(res, 401, { ok: false, error: 'unauthorized' }); return; }
  const abs = path.resolve('/', decodeURIComponent(slash >= 0 ? rest.slice(slash + 1) : ''));
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { json(res, 404, { ok: false, error: '文件不存在' }); return; }
  const st = fs.statSync(abs);
  sendFile(res, abs, {
    'Content-Type': LOCAL_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
  });
}

function serveStatic(res: http.ServerResponse, pathname: string) {
  if (!CLIENT_DIST) { json(res, 503, { ok: false, error: 'client 未构建：请在 webui/ 执行 npm run build，或用 npm run dev 走 vite' }); return; }
  let file = path.join(CLIENT_DIST, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(CLIENT_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(CLIENT_DIST, 'index.html');
  const ext = path.extname(file);
  sendFile(res, file, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      if (pathname.startsWith('/api/local/')) { serveLocalFile(res, pathname); return; } // 鉴权走路径内嵌 token
      if (!authorized(req, url)) { json(res, 401, { ok: false, error: 'unauthorized' }); return; }
      if (!(await router.handle(req, res, pathname))) json(res, 404, { ok: false, error: 'not found' });
      return;
    }
    serveStatic(res, pathname);
  } catch (e: any) {
    // 顶层兜底：任何未捕获异常只失败本次请求，绝不让主进程崩溃
    console.error('[http] 未捕获异常:', e?.message || e);
    try { if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' }); else res.end(); } catch { /* ignore */ }
  }
});

const wss = new WebSocketServer({ noServer: true });
attachWs(wss, sm);
const termWss = new WebSocketServer({ noServer: true });
attachTermWs(termWss, tm);
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (!authorized(req, url)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  if (url.pathname === '/ws') { wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)); return; }
  if (url.pathname === '/ws/term') { termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req)); return; }
  socket.destroy();
});

server.on('error', (e: any) => {
  console.error(e?.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请换 --port 或关闭占用进程` : e);
  process.exit(1);
});
server.listen(port, host, () => {
  const url = `http://${host}:${port}/?token=${token}`;
  console.log(`\nSemaWork 已启动：${url}\n`);
  if (shouldOpen) openExternal(url).catch(() => undefined);
});

let closing = false;
let closingAt = 0;
async function shutdown() {
  if (closing) {
    // npm 等父进程会把终端信号再转发一次，1 秒内的重复信号视为同一次 Ctrl+C，不打断优雅关闭
    if (Date.now() - closingAt < 1000) return;
    console.log('\n再次收到信号，强制退出');
    process.exit(1);
  }
  closing = true;
  closingAt = Date.now();
  console.log('\n正在关闭…');
  tm.killAll();
  await sm.dispose(); // 内部等待全部 worker 真正退出（5 秒超时 SIGKILL）
  server.close();
  process.exit(0);
}
// 兜底：异步回调里漏掉的异常只打日志，不让单个请求的错误把整个服务（含所有会话 worker/终端）拖垮
process.on('uncaughtException', (err) => { console.error('[server] uncaughtException:', err); });
process.on('unhandledRejection', (reason) => { console.error('[server] unhandledRejection:', reason); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

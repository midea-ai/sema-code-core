/**
 * SemaWork 服务端（库形态）：startServer() 起 HTTP + WebSocket，返回地址与关闭函数。
 * 两个宿主共用：
 *   - index.ts   命令行入口（npm start），负责参数、token 落盘、信号处理
 *   - desktop/   Electron 主进程，进程内直接调用，随机端口
 * 只监听 loopback；REST/WS 必须携带 token（Authorization: Bearer 或 ?token=）。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { RegistryStore } from './registry/registry';
import { SessionManager } from './sessions';
import { Router, json, sendFile } from './http/router';
import { attachWs } from './ws/handler';
import { TerminalManager } from './terminal/manager';
import { attachTermWs } from './ws/terminal';
import { isVizPath } from '../../shared/viz';

export interface StartServerOptions {
  /** 监听端口；0 = 随机空闲端口 */
  port: number;
  /** 只允许 loopback，缺省 127.0.0.1 */
  host?: string;
  token: string;
}

export interface ServerHandle {
  host: string;
  port: number;
  token: string;
  /** 带 token 的可直接打开的地址 */
  url: string;
  /** 优雅关闭：杀终端、等全部 worker 退出、关 HTTP */
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
  // pdf.js 的 worker 产物是 .mjs（module worker 严格校验 JS mime），解码器是 .wasm
  '.mjs': 'application/javascript; charset=utf-8', '.wasm': 'application/wasm',
};
/** 可视化 html 注入 runtime 的体积上限（技能约定文件 < 1MB，留余量） */
const VIZ_INJECT_MAX_BYTES = 4 * 1024 * 1024;

const LOCAL_MIME: Record<string, string> = {
  ...MIME, '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

export function startServer(opts: StartServerOptions): Promise<ServerHandle> {
  const host = opts.host || '127.0.0.1';
  const { token } = opts;
  if (!LOOPBACK.has(host)) return Promise.reject(new Error(`当前阶段仅支持 loopback 监听（--host ${host}）`));
  if (!/^[0-9a-f]{32}$/.test(token)) return Promise.reject(new Error('token 须为 32 位十六进制'));

  const entryPath = path.join(__dirname, 'worker-entry.js');
  if (!fs.existsSync(entryPath)) return Promise.reject(new Error(`找不到 worker 入口 ${entryPath}，请先在 webui/ 执行 npm run build`));

  const registry = new RegistryStore();
  const sm = new SessionManager(registry, entryPath);
  const tm = new TerminalManager();
  sm.killTerminals = (sid) => tm.killBySession(sid);
  const router = new Router(sm, tm);

  // 静态资源：client 构建产物
  const CLIENT_DIST = [path.join(__dirname, '..', '..', 'client', 'dist'), path.join(__dirname, 'public')].find(p => fs.existsSync(path.join(p, 'index.html')));

  function authorized(req: http.IncomingMessage, url: URL): boolean {
    const h = req.headers.authorization;
    if (h && h === `Bearer ${token}`) return true;
    return url.searchParams.get('token') === token;
  }

  // 本地文件代理：右栏浏览器内嵌 file:// 页面用（iframe 无法直接加载 file://）。
  // 形如 /api/local/<token>/<绝对路径>：token 嵌在路径前缀，页面内相对资源解析后仍落在该前缀下，
  // 因此 iframe 可用无 allow-same-origin 的沙箱（不透明源，防内嵌页脚本借同源偷 token 调 API）
  function serveLocalFile(res: http.ServerResponse, pathname: string) {
    const rest = pathname.slice('/api/local/'.length);
    const slash = rest.indexOf('/');
    const tok = decodeURIComponent(slash >= 0 ? rest.slice(0, slash) : rest);
    if (tok !== token) { json(res, 401, { ok: false, error: 'unauthorized' }); return; }
    const abs = path.resolve('/', decodeURIComponent(slash >= 0 ? rest.slice(slash + 1) : ''));
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { json(res, 404, { ok: false, error: '文件不存在' }); return; }
    const st = fs.statSync(abs);
    // 可视化产物（attachments/<uuid>/*.html）：注入宿主 runtime（高度上报 / 截图），文件本身保持干净，
    // 用系统浏览器打开时脚本 404 不影响页面。超大文件不注入，走普通流式发送。
    // 必须是 classic 脚本：iframe 是不透明源，module 脚本按 CORS 取会被拒
    if (isVizPath(abs) && st.size <= VIZ_INJECT_MAX_BYTES) {
      let html = fs.readFileSync(abs, 'utf8');
      const tag = '<script src="/viz-runtime.js"></script>';
      html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html;
      const buf = Buffer.from(html, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
      return;
    }
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
    // viz-runtime.js 是固定文件名（不带 hash），不能长缓存
    const noStore = ext === '.html' || pathname === '/viz-runtime.js';
    sendFile(res, file, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': noStore ? 'no-store' : 'public, max-age=31536000, immutable' });
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

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    tm.killAll();
    await sm.dispose(); // 内部等待全部 worker 真正退出（5 秒超时 SIGKILL）
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return new Promise<ServerHandle>((resolve, reject) => {
    server.once('error', (e: any) => {
      reject(new Error(e?.code === 'EADDRINUSE' ? `端口 ${opts.port} 已被占用，请换 --port 或关闭占用进程` : String(e?.message || e)));
    });
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ host, port, token, url: `http://${host}:${port}/?token=${token}`, close });
    });
  });
}

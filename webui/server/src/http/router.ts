/**
 * REST：注册表 / 会话快照 / 设置 / 系统交互（打开目录、外部浏览器）。极简路由，不引框架。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { SessionManager } from '../sessions';
import { TRASH_DIR } from '../registry/registry';
import { searchFiles } from '../files/search';
import { readFileInDir, listDir, resolvePath, statPaths, rawFileInDir } from '../files/read';
import { listOpenWithApps, appIconPath } from '../files/apps';

/** handler 自行写响应时返回此标记，handle() 不再套 json 包装 */
export const HANDLED = Symbol('handled');

const faviconCache = new Map<string, { type: string; buf: Buffer }>();

/** 探测 URL 能否被 iframe 内嵌：看 X-Frame-Options / CSP frame-ancestors（5s 超时，失败视为不可嵌） */
async function probeEmbeddable(url: string): Promise<{ embeddable: boolean; reason?: string }> {
  if (!/^https?:\/\//i.test(url)) return { embeddable: false, reason: 'scheme' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal }).catch(() => null);
    if (!res || res.status === 405 || res.status === 404) res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctl.signal });
    const xfo = (res.headers.get('x-frame-options') || '').toLowerCase();
    if (xfo.includes('deny') || xfo.includes('sameorigin')) return { embeddable: false, reason: 'x-frame-options' };
    const csp = (res.headers.get('content-security-policy') || '').toLowerCase();
    const fa = csp.split(';').map(s => s.trim()).find(s => s.startsWith('frame-ancestors'));
    if (fa && !/\*/.test(fa)) return { embeddable: false, reason: 'csp' };
    return { embeddable: true };
  } catch (e: any) {
    return { embeddable: false, reason: e?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally { clearTimeout(timer); }
}

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: Record<string, string>, body: any) => Promise<any> | any;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, (err, stdout) => err ? reject(err) : resolve(stdout)));
}

export function revealInFileManager(target: string) {
  if (IS_MAC) return run('open', ['-R', target]).catch(() => run('open', [target]));
  if (IS_WIN) return run('explorer', [target]).catch(() => undefined);
  return run('xdg-open', [target]);
}

export function openExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) throw new Error('仅允许 http/https URL');
  if (IS_MAC) return run('open', [url]);
  if (IS_WIN) return run('cmd', ['/c', 'start', '', url]);
  return run('xdg-open', [url]);
}

/** 移入废纸篓（macOS 走 Finder；其余平台移到 ~/.sema/webui/trash） */
async function trashDir(dir: string) {
  if (!fs.existsSync(dir)) return;
  if (IS_MAC) {
    try {
      await run('osascript', ['-e', `tell application "Finder" to delete POSIX file "${dir.replace(/"/g, '\\"')}"`]);
      return;
    } catch { /* fallthrough */ }
  }
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  fs.renameSync(dir, path.join(TRASH_DIR, `${Date.now()}-${path.basename(dir)}`));
}

async function pickDirectory(): Promise<string | null> {
  if (IS_MAC) {
    try {
      const out = await run('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择要导入的项目目录")']);
      return out.trim().replace(/\/$/, '') || null;
    } catch { return null; }
  }
  if (IS_WIN) {
    try {
      const ps = 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }';
      const out = await run('powershell', ['-NoProfile', '-Command', ps]);
      return out.trim() || null;
    } catch { return null; }
  }
  try { return (await run('zenity', ['--file-selection', '--directory'])).trim() || null; } catch { return null; }
}

export class Router {
  private routes: Route[] = [];

  constructor(private sm: SessionManager, private tm?: import('../terminal/manager').TerminalManager) {
    const reg = sm.registry;

    this.add('GET', '/api/bootstrap', () => ({ registry: reg.snapshot(), settings: reg.getSettings(), status: sm.statusMap(), platform: process.platform }));
    this.add('GET', '/api/registry', () => reg.snapshot());
    this.add('GET', '/api/settings', () => reg.getSettings());
    this.add('PUT', '/api/settings', async (_r, _s, _p, body) => {
      const s = reg.updateSettings(body || {});
      if (body?.coreConfig) await sm.dispatch('core.updateCoreConfig', undefined, { config: s.coreConfig });
      return s;
    });

    // ---- 项目 ----
    this.add('POST', '/api/projects', (_r, _s, _p, body) => {
      const p = body?.importPath ? reg.importProject(String(body.importPath), body.name) : reg.createProject(String(body?.name || '').trim());
      sm.broadcastRegistry();
      void sm.evictOverflow();
      return p;
    });
    this.add('POST', '/api/projects/pick-directory', async () => ({ path: await pickDirectory() }));
    this.add('PATCH', '/api/projects/:id', (_r, _s, p, body) => { const r = reg.renameProject(p.id, String(body?.name || '')); sm.broadcastRegistry(); return r; });
    this.add('DELETE', '/api/projects/:id', async (_r, _s, p) => {
      const removed = reg.removeProject(p.id);
      for (const s of removed) await sm.closeSession(s.id);
      sm.broadcastRegistry();
      return { removed: removed.length };
    });
    this.add('POST', '/api/projects/:id/reveal', async (_r, _s, p) => {
      const proj = reg.getProject(p.id); if (!proj) throw new Error('项目不存在');
      await revealInFileManager(proj.workingDir); return true;
    });

    // ---- 会话 ----
    this.add('POST', '/api/sessions', async (_r, _s, _p, body) => sm.createSession({ projectId: body?.projectId || undefined }));
    this.add('GET', '/api/sessions/:id/snapshot', (_r, _s, p) => sm.getSnapshot(p.id));
    this.add('PATCH', '/api/sessions/:id', (_r, _s, p, body) => {
      const r = reg.updateSession(p.id, { title: String(body?.title || '') }); sm.broadcastRegistry(); return r;
    });
    this.add('DELETE', '/api/sessions/:id', async (_r, _s, p) => {
      const rec = reg.getSession(p.id); if (!rec) return true;
      this.tm?.killBySession(p.id);
      await sm.closeSession(p.id);
      reg.removeSession(p.id);
      if (!rec.projectId) await trashDir(rec.workingDir);
      sm.broadcastRegistry();
      return true;
    });
    this.add('POST', '/api/sessions/:id/reveal', async (_r, _s, p) => {
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      await revealInFileManager(rec.workingDir); return true;
    });
    // 在文件管理器中定位会话目录内的某个文件（相对路径；realpath 必须落在 workingDir 内）
    this.add('POST', '/api/sessions/:id/reveal-file', async (_r, _s, p, body) => {
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      const rel = String(body?.path || '');
      if (!rel) throw new Error('缺少 path');
      await revealInFileManager(resolvePath(rec.workingDir, rel).abs); return true;
    });

    // ---- 文件查看：读取文件（相对路径限定会话目录内，绝对路径只读放行）/ 列目录 / 批量 stat / 原始字节 ----
    this.add('POST', '/api/sessions/:id/file', async (_r, _s, p, body) => {
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      return readFileInDir(rec.workingDir, String(body?.path || ''));
    });
    this.add('POST', '/api/sessions/:id/files/stat', async (_r, _s, p, body) => {
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      const paths = Array.isArray(body?.paths) ? body.paths.map(String) : [];
      return statPaths(rec.workingDir, paths);
    });
    this.add('GET', '/api/sessions/:id/raw', async (req, res, p) => {
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      const q = new URL(req.url || '/', 'http://x').searchParams;
      const { abs, size, mime } = rawFileInDir(rec.workingDir, q.get('path') || '');
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(abs).pipe(res);
      return HANDLED;
    });
    this.add('POST', '/api/sessions/:id/ls', async (_r, _s, p, body) => {
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      return listDir(rec.workingDir, String(body?.path || ''));
    });

    // ---- 终端（node-pty；数据流走 /ws/term） ----
    this.add('POST', '/api/sessions/:id/terminals', async (_r, _s, p, body) => {
      if (!this.tm) throw new Error('终端不可用');
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      return this.tm.create(p.id, rec.workingDir, Number(body?.cols) || 80, Number(body?.rows) || 24);
    });
    this.add('DELETE', '/api/terminals/:id', async (_r, _s, p) => { this.tm?.kill(p.id); return true; });
    // 用系统默认程序打开会话目录内的文件
    this.add('POST', '/api/sessions/:id/open-file', async (_r, _s, p, body) => {
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      const { abs } = resolvePath(rec.workingDir, String(body?.path || ''));
      const app = body?.app ? String(body.app) : '';
      if (IS_MAC) await run('open', app ? ['-a', app, abs] : [abs]); else if (IS_WIN) await run('cmd', ['/c', 'start', '', abs]); else await run('xdg-open', [abs]);
      return true;
    });
    // 「打开方式」候选应用（仅 macOS 有结果）与应用图标
    this.add('POST', '/api/sessions/:id/open-with', async (_r, _s, p, body) => {
      const rec = reg.getSession(p.id); if (!rec) throw new Error('会话不存在');
      return listOpenWithApps(resolvePath(rec.workingDir, String(body?.path || '')).abs);
    });
    this.add('GET', '/api/app-icon', async (req, res) => {
      const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || '';
      const file = appIconPath(id);
      if (!file) throw new Error('无图标');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(file).pipe(res);
      return HANDLED;
    });

    // ---- 文件搜索（输入框 @ 引用）：按会话或项目定位 workingDir，结果为相对路径 ----
    this.add('POST', '/api/files/search', async (_r, _s, _p, body) => {
      let dir: string | undefined;
      if (body?.sessionId) dir = reg.getSession(String(body.sessionId))?.workingDir;
      else if (body?.projectId) dir = reg.getProject(String(body.projectId))?.workingDir;
      if (!dir) throw new Error('会话或项目不存在');
      return searchFiles(dir, String(body?.query ?? ''), Number(body?.limit) || 50);
    });

    // ---- 系统 ----
    this.add('POST', '/api/open-external', async (_r, _s, _p, body) => { await openExternal(String(body?.url || '')); return true; });
    // 站点图标代理：取 origin/favicon.ico，内存缓存；失败返回 404 由前端回退为通用图标
    this.add('GET', '/api/favicon', async (req, res) => {
      const origin = new URL(req.url || '/', 'http://x').searchParams.get('origin') || '';
      if (!/^https?:\/\/[^/]+$/i.test(origin)) throw new Error('bad origin');
      let hit = faviconCache.get(origin);
      if (!hit) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        try {
          const r = await fetch(`${origin}/favicon.ico`, { redirect: 'follow', signal: ctl.signal });
          const type = r.headers.get('content-type') || '';
          if (!r.ok || !/image\//i.test(type)) throw new Error('no icon');
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length > 512 * 1024) throw new Error('too large');
          hit = { type, buf };
        } catch { hit = { type: '', buf: Buffer.alloc(0) }; }
        finally { clearTimeout(timer); }
        faviconCache.set(origin, hit);
      }
      if (!hit.buf.length) { json(res, 404, { ok: false, error: 'no icon' }); return HANDLED; }
      res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.buf.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(hit.buf);
      return HANDLED;
    });
    // 探测 URL 是否允许 iframe 内嵌，前端据此决定右栏预览还是系统浏览器
    this.add('POST', '/api/probe-url', async (_r, _s, _p, body) => probeEmbeddable(String(body?.url || '')));
  }

  private add(method: string, pattern: string, handler: Handler) {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_m, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    this.routes.push({ method, pattern: re, keys, handler });
  }

  /** 命中路由返回 true（已写响应）；未命中返回 false */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      try {
        let body: any = undefined;
        if (req.method !== 'GET') body = await readJson(req); // 畸形 JSON/超大 body 在此抛出，必须落在 catch 内
        const data = await r.handler(req, res, params, body);
        if (data !== HANDLED) json(res, 200, { ok: true, data });
      } catch (e: any) {
        json(res, 400, { ok: false, error: e?.message || String(e) });
      }
      return true;
    }
    return false;
  }
}

export function json(res: http.ServerResponse, status: number, data: any) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 20 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve(undefined);
      try { resolve(JSON.parse(s)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

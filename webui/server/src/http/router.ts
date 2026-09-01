/**
 * REST：注册表 / 会话快照 / 设置 / 系统交互（打开目录、外部浏览器）。极简路由，不引框架。
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { SessionManager } from '../sessions';
import { SEMA_DOCS_ROOT, WEBUI_HOME, removeEmptyDateParent } from '../registry/registry';
import { searchFiles } from '../files/search';
import { readFileInDir, listDir, resolvePath, statPaths, rawFileInDir } from '../files/read';
import { listOpenWithApps, appIconPath } from '../files/apps';
import { gitDiffList, gitDiffFile, gitRepoCheck } from '../files/gitDiff';
import { listCatalog, installResource, uninstallResource, listInstalled, toggleInstalled, removeInstalled, updateMcpConfig, updateMcpUseTools, userSkillsRoot, readUserMcp } from './ecosystem';
import { listMcpTools } from './mcpTools';

/** handler 自行写响应时返回此标记，handle() 不再套 json 包装 */
export const HANDLED = Symbol('handled');

const faviconCache = new Map<string, { type: string; buf: Buffer }>();

/** 抓取页面 HTML 头部（最多 64KB / 读到 </head> 即停，5s 超时；非 HTML 或失败返回空） */
async function fetchHtmlHead(url: string): Promise<string> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { Accept: 'text/html' } });
    if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '') || !r.body) return '';
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 64 * 1024) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value); size += value.length;
      if (/<\/head>/i.test(Buffer.concat(chunks).toString('utf8'))) break;
    }
    reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString('utf8');
  } catch { return ''; }
  finally { clearTimeout(timer); }
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

interface PageMeta { title: string; icon: string }
const metaCache = new Map<string, PageMeta>();
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.|192\.168\.|172\.)/i;

/** 从 HTML 头部解析 <title> 与 <link rel="icon">（优先 rel=icon，apple-touch-icon 兜底），icon 为绝对地址 */
function parsePageMeta(html: string, baseUrl: string): PageMeta {
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = tm ? decodeEntities(tm[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  let best = '';
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (tag.match(/\brel=["']([^"']*)["']/i)?.[1] || '').toLowerCase();
    if (!/(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    best = decodeEntities(href);
    if (/(^|\s)icon(\s|$)/.test(rel)) break;
  }
  let icon = '';
  try { if (best) icon = new URL(best, baseUrl).href; } catch { /* ignore */ }
  if (!/^https?:\/\//i.test(icon)) icon = '';
  return { title, icon };
}

/**
 * 取页面元信息（右栏浏览器标签的标题与图标；iframe 跨域读不到 document.title / <link rel=icon>）。
 * 未声明图标时回退 origin/favicon.ico；失败返回空由前端回退。本机/局域网开发服务器不缓存（内容随改动变化）。
 */
async function fetchPageMeta(url: string): Promise<PageMeta> {
  // file://：读本地 html 头部解析标题（图标不代理本地文件，留空由前端回退）
  if (/^file:\/\//i.test(url)) {
    try {
      const fp = decodeURIComponent(new URL(url).pathname);
      const fd = fs.openSync(fp, 'r');
      try {
        const buf = Buffer.alloc(64 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        return { title: parsePageMeta(buf.subarray(0, n).toString('utf8'), url).title, icon: '' };
      } finally { fs.closeSync(fd); }
    } catch { return { title: '', icon: '' }; }
  }
  if (!/^https?:\/\//i.test(url)) return { title: '', icon: '' };
  const key = url.replace(/#.*$/, '');
  const hit = metaCache.get(key);
  if (hit) return hit;
  const meta = parsePageMeta(await fetchHtmlHead(key), key);
  if (!meta.icon) { try { meta.icon = new URL('/favicon.ico', key).href; } catch { /* ignore */ } }
  if (!LOCAL_RE.test(key)) metaCache.set(key, meta);
  return meta;
}

async function fetchIcon(url: string, signal: AbortSignal): Promise<{ type: string; buf: Buffer } | null> {
  const r = await fetch(url, { redirect: 'follow', signal });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !/image\//i.test(type)) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 512 * 1024) return null;
  return { type, buf };
}

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

/** 移入废纸篓（macOS 走 Finder；失败或其余平台直接删除，与 transcript/history 的硬删一致） */
async function trashDir(dir: string) {
  if (!fs.existsSync(dir)) return;
  if (IS_MAC) {
    try {
      await run('osascript', ['-e', `tell application "Finder" to delete POSIX file "${dir.replace(/"/g, '\\"')}"`]);
      return;
    } catch { /* fallthrough */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
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

    this.add('GET', '/api/bootstrap', () => ({ registry: reg.snapshot(), settings: reg.getSettings(), status: sm.statusMap(), liveSessions: sm.liveSessionIds(), platform: process.platform }));
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
    this.add('DELETE', '/api/projects/:id', async (r, _s, p) => {
      const proj = reg.getProject(p.id);
      const sessions = reg.listSessions().filter(s => s.projectId === p.id);
      for (const s of sessions) { this.tm?.killBySession(s.id); await sm.closeSession(s.id); }
      const removed = reg.removeProject(p.id);
      // deleteFiles=1：仅 WebUI 受管目录且无其他引用时，连带 core 历史与文件夹（移入废纸篓）一起删除
      const deleteFiles = new URL(r.url || '/', 'http://x').searchParams.get('deleteFiles') === '1';
      const managedRoot = path.resolve(SEMA_DOCS_ROOT) + path.sep;
      if (deleteFiles && proj?.managedWorkingDir && !reg.hasWorkingDirReference(proj.workingDir) && path.resolve(proj.workingDir).startsWith(managedRoot)) {
        await sm.dispatch('core.deleteProjectHistory', undefined, { projectPath: proj.workingDir });
        await trashDir(proj.workingDir);
      }
      sm.broadcastRegistry();
      return { removed: removed.length };
    });
    this.add('POST', '/api/projects/:id/reveal', async (_r, _s, p) => {
      const proj = reg.getProject(p.id); if (!proj) throw new Error('项目不存在');
      await revealInFileManager(proj.workingDir); return true;
    });
    // 项目目录的历史输入（core 按 workingDir 落盘在 <semaRoot>/projects.conf）：草稿页输入框 ↑↓ 翻历史用
    this.add('GET', '/api/projects/:id/input-history', (_r, _s, p) => {
      const proj = reg.getProject(p.id); if (!proj) throw new Error('项目不存在');
      try {
        const semaRoot = process.env.SEMA_ROOT ? path.resolve(process.env.SEMA_ROOT) : path.dirname(WEBUI_HOME);
        const conf = JSON.parse(fs.readFileSync(path.join(semaRoot, 'projects.conf'), 'utf8'));
        const h = conf?.[proj.workingDir]?.history;
        return Array.isArray(h) ? h.filter((x: unknown): x is string => typeof x === 'string' && !!x) : [];
      } catch { return []; }
    });

    // ---- 会话 ----
    // 面板类路由（文件/终端/打开等）同时服务项目草稿页：id 可为会话或项目，两者都有 workingDir。
    // 伪作用域 ~skills：插件页「打开技能」复用文件窗口，根目录为用户级技能目录 <semaRoot>/skills
    const resolveScope = (id: string): { workingDir: string } => {
      if (id === '~skills') return { workingDir: userSkillsRoot() };
      const rec = reg.getSession(id) || reg.getProject(id);
      if (!rec) throw new Error('会话不存在');
      return rec;
    };
    this.add('POST', '/api/sessions', async (_r, _s, _p, body) => sm.createSession({ projectId: body?.projectId || undefined }));
    this.add('POST', '/api/sessions/:id/branch', async (_r, _s, p, body) =>
      sm.branchSession(p.id, typeof body?.beforeMessageUuid === 'string' ? body.beforeMessageUuid : undefined));
    this.add('GET', '/api/sessions/:id/snapshot', (_r, _s, p) => sm.getSnapshot(p.id));
    this.add('PATCH', '/api/sessions/:id', (_r, _s, p, body) => {
      const r = reg.updateSession(p.id, { title: String(body?.title || '') }); sm.broadcastRegistry(); return r;
    });
    this.add('DELETE', '/api/sessions/:id', async (_r, _s, p) => {
      const rec = reg.getSession(p.id); if (!rec) return true;
      this.tm?.killBySession(p.id);
      await sm.closeSession(p.id);
      reg.removeSession(p.id);
      const hasOtherRef = reg.hasWorkingDirReference(rec.workingDir);
      const managedRoot = path.resolve(SEMA_DOCS_ROOT) + path.sep;
      if ((rec.managedWorkingDir ?? !rec.projectId) && !hasOtherRef && path.resolve(rec.workingDir).startsWith(managedRoot)) {
        await sm.dispatch('core.deleteProjectHistory', undefined, { projectPath: rec.workingDir });
        await trashDir(rec.workingDir);
        removeEmptyDateParent(rec.workingDir);
      } else {
        await sm.dispatch('core.deleteSessionHistory', undefined, { sessionId: rec.id, projectPath: rec.workingDir });
      }
      sm.broadcastRegistry();
      return true;
    });
    this.add('POST', '/api/sessions/:id/reveal', async (_r, _s, p) => {
      const rec = resolveScope(p.id);
      await revealInFileManager(rec.workingDir); return true;
    });
    // 在文件管理器中定位文件（相对路径限会话目录内，绝对路径放行，与文件读取一致）
    this.add('POST', '/api/sessions/:id/reveal-file', async (_r, _s, p, body) => {
      const rec = resolveScope(p.id);
      const rel = String(body?.path || '');
      if (!rel) throw new Error('缺少 path');
      await revealInFileManager(resolvePath(rec.workingDir, rel).abs); return true;
    });

    // ---- 文件查看：读取文件（相对路径限定会话目录内，绝对路径只读放行）/ 列目录 / 批量 stat / 原始字节 ----
    this.add('POST', '/api/sessions/:id/file', async (_r, _s, p, body) => {
      const rec = resolveScope(p.id);
      return readFileInDir(rec.workingDir, String(body?.path || ''));
    });
    this.add('POST', '/api/sessions/:id/files/stat', async (_r, _s, p, body) => {
      const rec = resolveScope(p.id);
      const paths = Array.isArray(body?.paths) ? body.paths.map(String) : [];
      return statPaths(rec.workingDir, paths);
    });
    this.add('GET', '/api/sessions/:id/raw', async (req, res, p) => {
      const rec = resolveScope(p.id);
      const q = new URL(req.url || '/', 'http://x').searchParams;
      const { abs, size, mime } = rawFileInDir(rec.workingDir, q.get('path') || '');
      sendFile(res, abs, { 'Content-Type': mime, 'Content-Length': size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return HANDLED;
    });
    this.add('POST', '/api/sessions/:id/ls', async (_r, _s, p, body) => {
      const rec = resolveScope(p.id);
      return listDir(rec.workingDir, String(body?.path || ''));
    });
    // 审阅面板 Git 视图（实时现算）：check 探测是否仓库；list 文件清单（无 patch）；file 单文件 diff
    this.add('POST', '/api/sessions/:id/git-diff', async (_r, _s, p, body) => {
      const rec = resolveScope(p.id);
      if (body?.mode === 'check') return gitRepoCheck(rec.workingDir);
      if (body?.mode === 'file') return gitDiffFile(rec.workingDir, String(body?.path || ''));
      return gitDiffList(rec.workingDir);
    });

    // ---- 终端（node-pty；数据流走 /ws/term） ----
    this.add('POST', '/api/sessions/:id/terminals', async (_r, _s, p, body) => {
      if (!this.tm) throw new Error('终端不可用');
      const rec = resolveScope(p.id);
      return this.tm.create(p.id, rec.workingDir, Number(body?.cols) || 80, Number(body?.rows) || 24);
    });
    this.add('DELETE', '/api/terminals/:id', async (_r, _s, p) => { this.tm?.kill(p.id); return true; });
    // 用系统默认程序打开会话目录内的文件
    this.add('POST', '/api/sessions/:id/open-file', async (_r, _s, p, body) => {
      const rec = resolveScope(p.id);
      const { abs } = resolvePath(rec.workingDir, String(body?.path || ''));
      const app = body?.app ? String(body.app) : '';
      if (IS_MAC) await run('open', app ? ['-a', app, abs] : [abs]); else if (IS_WIN) await run('cmd', ['/c', 'start', '', abs]); else await run('xdg-open', [abs]);
      return true;
    });
    // 「打开方式」候选应用（仅 macOS 有结果）与应用图标
    this.add('POST', '/api/sessions/:id/open-with', async (_r, _s, p, body) => {
      const rec = resolveScope(p.id);
      return listOpenWithApps(resolvePath(rec.workingDir, String(body?.path || '')).abs);
    });
    this.add('GET', '/api/app-icon', async (req, res) => {
      const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || '';
      const file = appIconPath(id);
      if (!file) throw new Error('无图标');
      sendFile(res, file, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      return HANDLED;
    });

    // ---- 文件搜索（输入框 @ 引用）：按会话或项目定位 workingDir，结果为相对路径 ----
    this.add('POST', '/api/files/search', async (_r, _s, _p, body) => {
      let dir: string | undefined;
      if (body?.sessionId) dir = resolveScope(String(body.sessionId)).workingDir;
      else if (body?.projectId) dir = reg.getProject(String(body.projectId))?.workingDir;
      if (!dir) throw new Error('会话或项目不存在');
      return searchFiles(dir, String(body?.query ?? ''), Number(body?.limit) || 50);
    });

    // ---- 系统 ----
    this.add('POST', '/api/open-external', async (_r, _s, _p, body) => { await openExternal(String(body?.url || '')); return true; });
    // 站点图标代理（内存缓存；失败返回 404 由前端回退为通用图标）
    this.add('GET', '/api/favicon', async (req, res) => {
      const q = new URL(req.url || '/', 'http://x').searchParams;
      const origin = q.get('origin') || '';
      const direct = q.get('url') || '';
      // url= 直接取指定图标地址（页面元信息解析出的 <link rel=icon>）；origin= 按站点取 /favicon.ico → 首页声明的图标
      const cacheKey = direct || origin;
      if (direct ? !/^https?:\/\/[^/]+\//i.test(direct) : !/^https?:\/\/[^/]+$/i.test(origin)) throw new Error('bad url');
      let hit = faviconCache.get(cacheKey);
      if (!hit) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        try {
          if (direct) hit = (await fetchIcon(direct, ctl.signal).catch(() => null)) || undefined;
          else {
            hit = (await fetchIcon(`${origin}/favicon.ico`, ctl.signal).catch(() => null)) || undefined;
            if (!hit) {
              const declared = (await fetchPageMeta(origin + '/')).icon;
              if (declared) hit = (await fetchIcon(declared, ctl.signal).catch(() => null)) || undefined;
            }
          }
          if (!hit) throw new Error('no icon');
        } catch { hit = { type: '', buf: Buffer.alloc(0) }; }
        finally { clearTimeout(timer); }
        faviconCache.set(cacheKey, hit);
      }
      if (!hit.buf.length) { json(res, 404, { ok: false, error: 'no icon' }); return HANDLED; }
      res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.buf.length, 'Cache-Control': 'public, max-age=86400' });
      res.end(hit.buf);
      return HANDLED;
    });
    // 探测 URL 是否允许 iframe 内嵌，前端据此决定右栏预览还是系统浏览器
    // 日程：全部目录的定时任务 / 启停删除
    this.add('GET', '/api/cron', () => sm.listAllCron());
    this.add('POST', '/api/cron/:action', (_r, _s, p, body) => {
      if (p.action !== 'delete' && p.action !== 'enable' && p.action !== 'disable') throw new Error(`未知操作: ${p.action}`);
      if (!body?.workingDir || !body?.id) throw new Error('缺少 workingDir / id');
      return sm.cronAction(String(body.workingDir), p.action, String(body.id));
    });
    // 生态市场：内置资源目录 / 安装（复制到用户级）/ 卸载
    this.add('GET', '/api/eco/catalog', () => listCatalog());
    // skill 装/卸/删后广播全部 worker 清缓存重扫；mcp 写操作后广播刷新连接（仅重连有变动的 server）。均不阻塞响应
    const refreshSkills = () => { void sm.dispatch('core.refreshSkills', undefined, {}).catch(() => null); };
    const refreshMcp = () => { void sm.dispatch('core.refreshMCPServerInfo', undefined, {}).catch(() => null); };
    this.add('POST', '/api/eco/install', async (_r, _s, _p, body) => {
      const id = String(body?.id || '');
      const r = await installResource(id, !!body?.overwrite);
      if (r === true) listCatalog().find(i => i.id === id)?.kind === 'skill' ? refreshSkills() : refreshMcp();
      return r;
    });
    this.add('POST', '/api/eco/uninstall', async (_r, _s, _p, body) => {
      const id = String(body?.id || '');
      const kind = listCatalog().find(i => i.id === id)?.kind;
      const r = await uninstallResource(id);
      kind === 'skill' ? refreshSkills() : refreshMcp();
      return r;
    });
    // 已安装（用户级全量）：列表 / MCP 启停 / 删除 / SKILL.md 读写 / MCP 配置更新
    this.add('GET', '/api/eco/installed', () => listInstalled());
    // worker 返回的 MCPServerInfo[] → 用户级 EcoMcpStatus[]（tools 仅在 core 已拿到 capabilities 时返回）
    const mapMcpStatus = (infos: any[]) => {
      const userKeys = new Set(Object.keys(readUserMcp().mcpServers || {}));
      return (infos || []).filter(i => userKeys.has(i?.config?.name)).map(i => ({
        id: i.config.name,
        connectStatus: i.connectStatus || 'disconnected',
        error: i.error,
        // core 已拼好 "路径:起始行-结束行" 定位串（找不到范围时为纯路径），前端拿去打开文件窗口定位
        filePath: i.filePath,
        tools: i.capabilities?.tools ? i.capabilities.tools.map((t: any) => ({ name: t.name, description: t.description })) : undefined,
      }));
    };
    this.add('POST', '/api/eco/installed/toggle', async (_r, _s, _p, body) => {
      if (body?.kind !== 'skill' && body?.kind !== 'mcp') throw new Error('kind 必须是 skill / mcp');
      if (body.kind === 'skill') return toggleInstalled('skill', String(body?.id || ''), !!body?.enabled);
      // mcp 启停走配置 worker 的 core（写 settings + 断/连完成才返回），响应带权威状态；其余 worker 广播同步
      const infos = await sm.dispatch(body?.enabled ? 'core.enableMCPServer' : 'core.disableMCPServer', undefined, { name: String(body?.id || '') });
      refreshMcp();
      return mapMcpStatus(infos);
    });
    this.add('POST', '/api/eco/installed/remove', (_r, _s, _p, body) => {
      if (body?.kind !== 'skill' && body?.kind !== 'mcp') throw new Error('kind 必须是 skill / mcp');
      const r = removeInstalled(body.kind, String(body?.id || ''));
      body.kind === 'skill' ? refreshSkills() : refreshMcp();
      return r;
    });
    this.add('PUT', '/api/eco/installed/mcp', (_r, _s, _p, body) => {
      const r = updateMcpConfig(String(body?.id || ''), body?.config);
      refreshMcp();
      return r;
    });
    // MCP 工具列表探测（短连，POST 避免 server 名走 URL 编码）与单工具开关（toolNames: string[] | null，null=全部可用）
    this.add('POST', '/api/eco/installed/mcp/tools', (_r, _s, _p, body) => listMcpTools(String(body?.id || ''), !!body?.refresh));
    this.add('PUT', '/api/eco/installed/mcp/use-tools', (_r, _s, _p, body) => {
      const r = updateMcpUseTools(String(body?.id || ''), body?.toolNames === null || body?.toolNames === undefined ? null : body.toolNames);
      refreshMcp();
      return r;
    });
    // 已安装 MCP 的实时连接状态：读配置 worker（~/.sema/webui/workspace，启动即常驻）里 core 的连接信息
    this.add('GET', '/api/eco/installed/mcp/status', async () =>
      mapMcpStatus(await sm.dispatch('core.getMCPServerInfo', undefined, {})));
    this.add('POST', '/api/probe-url', async (_r, _s, _p, body) => probeEmbeddable(String(body?.url || '')));
    // 页面元信息：标题 + 图标地址（右栏浏览器标签）
    this.add('POST', '/api/page-meta', async (_r, _s, _p, body) => fetchPageMeta(String(body?.url || '')));
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

/**
 * 以流方式回写本地文件。响应头在流成功 open 之后才写，这样 EPERM/ENOENT 等打开失败能返回 JSON 错误；
 * 任何阶段的流错误都被捕获（不挂 error 监听会变成 Unhandled 'error' event 把整个进程打挂）。
 */
export function sendFile(res: http.ServerResponse, file: string, headers: Record<string, string | number>) {
  const stream = fs.createReadStream(file);
  stream.on('open', () => { res.writeHead(200, headers); stream.pipe(res); });
  stream.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[http] 读取文件失败 ${file}: ${err.message}`);
    if (!res.headersSent) json(res, err.code === 'ENOENT' ? 404 : 500, { ok: false, error: `读取文件失败: ${err.message}` });
    else res.destroy();
  });
  res.on('close', () => stream.destroy());
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

/**
 * 「打开方式」候选程序（仅 macOS）：通过 osascript JXA 的 ObjC 桥调 NSWorkspace 取能打开该文件的应用、
 * 默认应用，并把应用图标导出为 PNG 缓存到 ~/.sema/webui/app-icons/。其他平台返回空列表，前端退化为「用默认程序打开」。
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { WEBUI_HOME } from '../registry/registry';

export interface OpenWithApp { id: string; name: string; path: string; icon: boolean }
export interface OpenWithResult { default?: string; apps: OpenWithApp[] }

const IS_MAC = process.platform === 'darwin';
const ICON_DIR = path.join(WEBUI_HOME, 'app-icons');
// 按扩展名缓存候选列表（进程生命周期内有效；安装新应用后重启生效）
const listCache = new Map<string, Promise<OpenWithResult>>();

function jxa(script: string, timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => execFile('osascript', ['-l', 'JavaScript', '-e', script], { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
}

function iconFile(id: string) { return path.join(ICON_DIR, `${id.replace(/[^\w.\-]/g, '_')}.png`); }

/** 候选应用 + 默认应用；同时把尚未缓存的图标导出为 64px PNG */
export function listOpenWithApps(absPath: string): Promise<OpenWithResult> {
  if (!IS_MAC) return Promise.resolve({ apps: [] });
  const ext = path.extname(absPath).toLowerCase() || path.basename(absPath);
  let p = listCache.get(ext);
  if (!p) {
    p = queryApps(absPath).catch(e => { listCache.delete(ext); throw e; });
    listCache.set(ext, p);
  }
  return p;
}

async function queryApps(absPath: string): Promise<OpenWithResult> {
  fs.mkdirSync(ICON_DIR, { recursive: true });
  const script = `
ObjC.import('AppKit');
const file = ${JSON.stringify(absPath)};
const iconDir = ${JSON.stringify(ICON_DIR)};
const ws = $.NSWorkspace.sharedWorkspace;
const url = $.NSURL.fileURLWithPath(file);
const str = x => (x && !x.isNil()) ? ObjC.unwrap(x) : '';
const defUrl = ws.URLForApplicationToOpenURL(url);
const def = defUrl.isNil() ? '' : str(defUrl.path);
const urls = ws.URLsForApplicationsToOpenURL(url);
const out = [];
const seen = {};
function exportIcon(appPath, target) {
  if ($.NSFileManager.defaultManager.fileExistsAtPath(target)) return true;
  const img = ws.iconForFile(appPath);
  img.setSize($.NSMakeSize(64, 64));
  const cg = img.CGImageForProposedRectContextHints($(), $(), $());
  if (!cg) return false;
  const rep = $.NSBitmapImageRep.alloc.initWithCGImage(cg);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
  return png.writeToFileAtomically(target, true);
}
for (let i = 0; i < urls.count; i++) {
  const u = urls.objectAtIndex(i);
  const appPath = str(u.path);
  const b = $.NSBundle.bundleWithURL(u);
  if (b.isNil()) continue;
  let id = str(b.bundleIdentifier);
  if (!id) id = appPath;
  if (seen[id]) continue; seen[id] = 1;
  const info = k => str(b.objectForInfoDictionaryKey(k));
  const name = info('CFBundleDisplayName') || info('CFBundleName') || appPath.split('/').pop().replace(/\\.app$/, '');
  const target = iconDir + '/' + id.replace(/[^\\w.\\-]/g, '_') + '.png';
  let icon = false;
  try { icon = !!exportIcon(appPath, target); } catch (e) { icon = false; }
  out.push({ id, name, path: appPath, icon, isDefault: appPath === def });
}
JSON.stringify(out);
`;
  const raw = await jxa(script);
  const list: Array<OpenWithApp & { isDefault: boolean }> = JSON.parse(raw.trim() || '[]');
  // 默认应用置顶，其余按名称排序
  list.sort((a, b) => (a.isDefault === b.isDefault ? a.name.localeCompare(b.name) : a.isDefault ? -1 : 1));
  return { default: list.find(a => a.isDefault)?.id, apps: list.map(({ isDefault: _d, ...a }) => a) };
}

/** 已缓存的图标文件路径（不存在返回 undefined） */
export function appIconPath(id: string): string | undefined {
  const f = iconFile(id);
  return fs.existsSync(f) ? f : undefined;
}

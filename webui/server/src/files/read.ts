/**
 * 文件查看：读取 / 列目录 / 批量 stat / 原始字节。
 * 相对路径限定在 workingDir 内（realpath 校验，防穿越）；绝对路径允许只读访问（本机单用户工具，
 * 对话里模型常输出 workingDir 之外的绝对路径），返回 inside 标记由前端区分展示。
 */
import fs from 'fs';
import path from 'path';

const MAX_TEXT = 1024 * 1024; // 超过 1MB 只返回前 1MB
const MAX_RAW = 50 * 1024 * 1024; // raw 字节流上限

export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
};

export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

/** 解析路径：相对 → 必须在 workingDir 内；绝对 → 原样（只读）。返回 realpath 与是否在目录内 */
export function resolvePath(workingDir: string, p: string): { abs: string; inside: boolean } {
  const root = fs.realpathSync(workingDir);
  const abs = isAbsolutePath(p) ? path.resolve(p) : path.resolve(root, p || '.');
  if (!fs.existsSync(abs)) throw new Error('文件不存在');
  const real = fs.realpathSync(abs);
  const inside = real === root || real.startsWith(root + path.sep);
  if (!inside && !isAbsolutePath(p)) throw new Error('路径不在会话目录内');
  return { abs: real, inside };
}

/** 限定在 workingDir 内的解析（写操作 / 系统打开等沿用） */
export function resolveInDir(workingDir: string, rel: string): string {
  const { abs, inside } = resolvePath(workingDir, rel);
  if (!inside) throw new Error('路径不在会话目录内');
  return abs;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function readFileInDir(workingDir: string, rel: string) {
  const { abs, inside } = resolvePath(workingDir, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('是目录');
  const fd = fs.openSync(abs, 'r');
  try {
    const len = Math.min(st.size, MAX_TEXT);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const ext = path.extname(abs).toLowerCase();
    const binary = !!IMAGE_MIME[ext] && ext !== '.svg' ? true : looksBinary(buf);
    return { path: rel, abs, inside, size: st.size, mtime: st.mtimeMs, truncated: st.size > MAX_TEXT, binary, image: !!IMAGE_MIME[ext], content: binary ? '' : buf.toString('utf8') };
  } finally { fs.closeSync(fd); }
}

/** 批量 stat：对话里识别出的候选路径，确认哪些真实存在（不存在不抛错） */
export function statPaths(workingDir: string, paths: string[]) {
  const out: Record<string, { exists: boolean; isDir: boolean; inside: boolean; image: boolean }> = {};
  for (const p of paths.slice(0, 100)) {
    try {
      const { abs, inside } = resolvePath(workingDir, p);
      const isDir = fs.statSync(abs).isDirectory();
      out[p] = { exists: true, isDir, inside, image: !isDir && !!IMAGE_MIME[path.extname(abs).toLowerCase()] };
    } catch { out[p] = { exists: false, isDir: false, inside: false, image: false }; }
  }
  return out;
}

/** 原始字节（图片预览用）：返回绝对路径与 mime，由路由层流式写回 */
export function rawFileInDir(workingDir: string, rel: string) {
  const { abs } = resolvePath(workingDir, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('是目录');
  if (st.size > MAX_RAW) throw new Error('文件过大');
  const ext = path.extname(abs).toLowerCase();
  return { abs, size: st.size, mime: IMAGE_MIME[ext] || 'application/octet-stream' };
}

const SKIP = new Set(['node_modules', '.DS_Store']);

export function listDir(workingDir: string, rel: string) {
  const abs = resolveInDir(workingDir, rel);
  if (!fs.statSync(abs).isDirectory()) throw new Error('不是目录');
  const items = fs.readdirSync(abs, { withFileTypes: true })
    .filter(d => !SKIP.has(d.name))
    .map(d => ({ name: d.name, isDirectory: d.isDirectory() || (d.isSymbolicLink() && safeIsDir(path.join(abs, d.name))) }))
    .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
  return { path: rel, items };
}

function safeIsDir(p: string) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

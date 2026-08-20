/**
 * 工作目录文件搜索（供输入框 @ 文件引用使用）。
 * - 列文件优先 ripgrep（PATH 中的 rg → @vscode/ripgrep 内置二进制），遵守 .gitignore；不可用时退化为 Node 递归遍历 + 固定排除表
 * - 文件清单按 root 缓存 10s，避免每个按键都跑一次 rg
 * - 过滤/排序对齐插件 FileOperationManager.searchWorkspaceFiles：basename 前缀 > basename 包含 > 路径包含 > 驼峰子序列；祖先目录名命中时补出目录条目
 * - 结果只返回相对路径；root 与每条命中都做 realpath 校验，软链逃逸出 root 的一律丢弃
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import type { FileSearchItem } from '../../../shared/types';

const CACHE_TTL_MS = 10_000;
const MAX_ENTRIES = 20_000;
const WALK_EXCLUDES = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'target', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.DS_Store', 'coverage', '.cache', '.gradle']);

interface CacheEntry { at: number; files: string[]; }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string[]>>();

let rgPath: string | null | undefined;
function resolveRg(): string | null {
  if (rgPath !== undefined) return rgPath;
  rgPath = null;
  const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) { rgPath = p; return rgPath; }
  }
  // 沿 sema-core 依赖找 @vscode/ripgrep（server 通过 file:../.. 依赖 sema-core，其 node_modules 内有内置二进制）
  try {
    const coreMain = require.resolve('sema-core');
    const mod = require.resolve('@vscode/ripgrep', { paths: [path.dirname(coreMain)] });
    const bin = path.join(path.dirname(mod), '..', 'bin', exe);
    if (fs.existsSync(bin)) rgPath = bin;
  } catch { /* ignore */ }
  return rgPath;
}

function listWithRg(rg: string, root: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(rg, ['--files', '--hidden', '-g', '!.git', '-g', '!node_modules'], { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => {
      if (err && (err as any).code !== 1) return reject(err);
      const lines = String(stdout).split(/\r?\n/).filter(Boolean).map(l => l.split(path.sep).join('/'));
      resolve(lines.length > MAX_ENTRIES ? lines.slice(0, MAX_ENTRIES) : lines);
    });
  });
}

function listWithWalk(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length && out.length < MAX_ENTRIES) {
    const rel = stack.pop()!;
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (WALK_EXCLUDES.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (e.isFile()) out.push(r);
      if (out.length >= MAX_ENTRIES) break;
    }
  }
  return out;
}

async function listFiles(root: string): Promise<string[]> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;
  const running = inflight.get(root);
  if (running) return running;
  const p = (async () => {
    let files: string[];
    const rg = resolveRg();
    if (rg) {
      try { files = await listWithRg(rg, root); } catch { files = listWithWalk(root); }
    } else files = listWithWalk(root);
    cache.set(root, { at: Date.now(), files });
    return files;
  })();
  inflight.set(root, p);
  try { return await p; } finally { inflight.delete(root); }
}

/** 驼峰/子序列匹配：query 的每个字符按顺序出现在 text 中 */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (let j = 0; j < text.length && i < query.length; j++) if (text[j] === query[i]) i++;
  return i === query.length;
}

/** 分数越小越靠前 */
function score(rel: string, isDir: boolean, q: string): number {
  const lower = rel.toLowerCase();
  const base = (isDir ? rel : rel.slice(rel.lastIndexOf('/') + 1)).toLowerCase();
  const baseName = isDir ? base.slice(base.lastIndexOf('/') + 1) : base;
  let s: number;
  if (baseName === q) s = 0;
  else if (baseName.startsWith(q)) s = 1;
  else if (baseName.includes(q)) s = 2;
  else if (lower.includes(q)) s = 3;
  else if (q.length >= 3 && isSubsequence(q, baseName)) s = 4;
  else s = 5;
  // 同档内：目录略靠后、路径越浅越靠前
  return s * 1000 + (isDir ? 400 : 0) + Math.min(399, rel.split('/').length * 10 + Math.min(9, Math.floor(rel.length / 40)));
}

function insideRoot(root: string, rel: string): boolean {
  try {
    const real = fs.realpathSync(path.join(root, rel));
    return real === root || real.startsWith(root + path.sep);
  } catch { return false; }
}

export async function searchFiles(workingDir: string, query: string, limit = 50): Promise<FileSearchItem[]> {
  let root: string;
  try { root = fs.realpathSync(workingDir); } catch { return []; }
  const files = await listFiles(root);
  const q = query.trim().replace(/\/+$/, '').toLowerCase();
  const max = Math.max(1, Math.min(200, limit));

  const candidates = new Map<string, { path: string; isDirectory: boolean; score: number }>();
  if (!q) {
    // 空查询：浅层优先的前 N 条
    for (const f of files) {
      const s = f.split('/').length * 10 + Math.min(9, Math.floor(f.length / 40));
      candidates.set(f, { path: f, isDirectory: false, score: s });
    }
  } else {
    for (const f of files) {
      const lower = f.toLowerCase();
      const base = lower.slice(lower.lastIndexOf('/') + 1);
      const baseHit = base.includes(q) || (q.length >= 3 && isSubsequence(q, base));
      const pathHit = lower.includes(q);
      if (!baseHit && !pathHit) continue;
      candidates.set(f, { path: f, isDirectory: false, score: score(f, false, q) });
      // 沿路径反推命中的目录条目
      if (pathHit) {
        const parts = f.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          // 目录段名含 query；query 自带 / 时按目录路径包含（如 "webui/doc"）
          if (!parts[i - 1].toLowerCase().includes(q) && !(q.includes('/') && dir.toLowerCase().includes(q))) continue;
          if (!candidates.has(dir)) candidates.set(dir, { path: dir, isDirectory: true, score: score(dir, true, q) });
        }
      }
    }
  }

  const sorted = [...candidates.values()].sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  const out: FileSearchItem[] = [];
  for (const c of sorted) {
    if (out.length >= max) break;
    if (!insideRoot(root, c.path)) continue;
    out.push({ path: c.path, isDirectory: c.isDirectory });
  }
  return out;
}

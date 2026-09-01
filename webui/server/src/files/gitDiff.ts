/**
 * Git 视图数据源：把 git diff 解析成审阅面板的 FileChange[]，实时现算不落盘。
 * - unstaged: 工作区 vs 暂存区（git diff --relative）+ 未跟踪文件（当新增）
 * - uncommitted: 工作区 vs HEAD（git diff HEAD --relative）+ 未跟踪文件；空仓库（无 HEAD）时全部当新增
 * 范围限定会话目录子树（--relative / 路径过滤），输出相对会话目录的路径。
 * 未跟踪大文件沿用「前几行预览 + diffText 省略提示」的截断约定，前端提示可点开文件。
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import type { FileChange, Hunk } from '../../../shared/types';
import { NEW_FILE_MAX_LINES, NEW_FILE_MAX_BYTES } from '../turnDiff';

const PREVIEW_LINES = 5;

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => err ? reject(err) : resolve(stdout)));
}

/** git 对非 ASCII 路径的 C 风格引号转义解码 */
function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\') {
      const n = inner[i + 1];
      if (/[0-7]/.test(n)) { bytes.push(parseInt(inner.slice(i + 1, i + 4), 8)); i += 3; }
      else { bytes.push(({ n: 10, t: 9, r: 13 } as any)[n] ?? n.charCodeAt(0)); i += 1; }
    } else bytes.push(inner.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** 解析 unified diff 输出为 FileChange[]（路径已是 --relative 后的相对路径） */
function parseUnifiedDiff(out: string): FileChange[] {
  const files: FileChange[] = [];
  let cur: FileChange | null = null;
  let hunk: Hunk | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: '', toolName: 'git', type: 'diff', additions: 0, removals: 0, patch: [], cumulative: true };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) { cur.type = 'new'; continue; }
    if (line.startsWith('deleted file mode')) { cur.deleted = true; continue; }
    if (line.startsWith('--- ')) {
      const p = unquotePath(line.slice(4).trim());
      if (p !== '/dev/null' && !cur.path) cur.path = p.replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = unquotePath(line.slice(4).trim());
      if (p !== '/dev/null') cur.path = p.replace(/^b\//, '');
      continue;
    }
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      hunk = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      cur.patch.push(hunk);
      continue;
    }
    if (hunk && /^[ +\-\\]/.test(line)) {
      hunk.lines.push(line);
      if (line[0] === '+') cur.additions++;
      else if (line[0] === '-') cur.removals++;
    }
  }
  return files.filter(f => f.path);
}

/** 未跟踪文件 → 「新增」FileChange；超限/二进制保留预览 + 省略提示 */
function untrackedChange(workingDir: string, rel: string): FileChange | null {
  const base: FileChange = { path: rel, toolName: 'git', type: 'new', additions: 0, removals: 0, patch: [], cumulative: true };
  try {
    const abs = path.join(workingDir, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return base; // 二进制：只列条目
    const lines = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const truncated = lines.length > NEW_FILE_MAX_LINES || st.size > NEW_FILE_MAX_BYTES;
    const shown = truncated ? lines.slice(0, PREVIEW_LINES) : lines;
    return {
      ...base,
      additions: lines.length,
      patch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines: shown.map(l => '+' + l) }],
      ...(truncated ? { diffText: `... (+${lines.length - PREVIEW_LINES} lines)` } : {}),
    };
  } catch { return base; }
}

/** 会话目录子树内的未跟踪文件（相对会话目录） */
async function untrackedFiles(workingDir: string): Promise<string[]> {
  const root = (await git(workingDir, ['rev-parse', '--show-toplevel'])).trim();
  const out = await git(workingDir, ['status', '--porcelain=v1', '-z', '-uall']);
  const rels: string[] = [];
  const entries = out.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    if (e[0] === 'R' || e[1] === 'R') i++; // 重命名多带一个源路径段
    if (!e.startsWith('??')) continue;
    const abs = path.resolve(root, e.slice(3));
    const rel = path.relative(workingDir, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) rels.push(rel.split(path.sep).join('/'));
  }
  return rels;
}

/** 轻量探测：会话目录是否在 Git 仓库内（决定审阅面板是否显示 Git 视图选项） */
export async function gitRepoCheck(workingDir: string): Promise<{ gitRepo: boolean }> {
  try { await git(workingDir, ['rev-parse', '--is-inside-work-tree']); return { gitRepo: true }; }
  catch { return { gitRepo: false }; }
}

export async function gitDiffFiles(workingDir: string, mode: 'unstaged' | 'uncommitted'): Promise<{ gitRepo: boolean; files: FileChange[]; ts: number }> {
  try { await git(workingDir, ['rev-parse', '--is-inside-work-tree']); }
  catch { return { gitRepo: false, files: [], ts: Date.now() }; }

  let hasHead = true;
  try { await git(workingDir, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }

  // 空仓库无 HEAD：uncommitted 退化为「工作区 vs 暂存区 + 未跟踪」（一切尚未提交）
  const args = mode === 'uncommitted' && hasHead
    ? ['diff', 'HEAD', '--no-color', '--unified=3', '--relative']
    : ['diff', '--no-color', '--unified=3', '--relative'];
  const files = parseUnifiedDiff(await git(workingDir, args));

  const seen = new Set(files.map(f => f.path));
  for (const rel of await untrackedFiles(workingDir)) {
    if (seen.has(rel)) continue;
    const c = untrackedChange(workingDir, rel);
    if (c) files.push(c);
  }
  return { gitRepo: true, files, ts: Date.now() };
}

/** 未提交改动的文件清单（含统计/状态但不带 patch）：分栏视图先取列表，diff 按选中文件单独取 */
export async function gitDiffList(workingDir: string): Promise<{ gitRepo: boolean; files: FileChange[]; ts: number }> {
  const full = await gitDiffFiles(workingDir, 'uncommitted');
  return { ...full, files: full.files.map(f => ({ ...f, patch: [], diffText: undefined })) };
}

/** 单文件的未提交 diff；未跟踪文件返回全文新增（沿用截断约定） */
export async function gitDiffFile(workingDir: string, rel: string): Promise<{ file: FileChange | null }> {
  if (!rel) return { file: null };
  try { await git(workingDir, ['rev-parse', '--is-inside-work-tree']); } catch { return { file: null }; }
  let hasHead = true;
  try { await git(workingDir, ['rev-parse', '--verify', 'HEAD']); } catch { hasHead = false; }
  const args = hasHead
    ? ['diff', 'HEAD', '--no-color', '--unified=3', '--relative', '--', rel]
    : ['diff', '--no-color', '--unified=3', '--relative', '--', rel];
  const out = await git(workingDir, args).catch(() => '');
  const parsed = parseUnifiedDiff(out);
  if (parsed.length) return { file: parsed[0] };
  return { file: untrackedChange(workingDir, rel) };
}

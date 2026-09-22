/**
 * 超长粘贴转存的附件文件：<semaRoot>/attachments/<uuid>/pasted-text.txt。
 * 写入 / 删除 / 退场；与会话无关（新会话草稿没有 sessionId 也能落盘），不走 worker。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

const FILE_NAME = 'pasted-text.txt';
/** 退场阈值：attachments/ 下子目录超过此数按 mtime 删最旧的 */
const MAX_DIRS = 100;
const UUID_RE = /^[0-9a-f-]{36}$/i;

/** 与 core getSemaRootDir 一致：SEMA_ROOT 环境变量优先，默认 ~/.sema */
function attachmentsRoot(): string {
  const semaRoot = process.env.SEMA_ROOT ? path.resolve(process.env.SEMA_ROOT) : path.join(os.homedir(), '.sema');
  return path.join(semaRoot, 'attachments');
}

/** 落盘一段粘贴文本，返回绝对路径；顺带执行退场 */
export function savePastedText(text: string): { path: string } {
  if (!text) throw new Error('缺少 text');
  const root = attachmentsRoot();
  const dir = path.join(root, randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE_NAME);
  fs.writeFileSync(file, text, 'utf8');
  evict(root);
  return { path: file };
}

/** 删除整个 uuid 目录：只接受本模块写出的形状 <root>/<uuid>/pasted-text.txt，其余拒绝 */
export function removePastedText(p: string): void {
  const root = attachmentsRoot();
  const rel = path.relative(root, path.resolve(p));
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || !UUID_RE.test(parts[0]) || parts[1] !== FILE_NAME) throw new Error('路径不合法');
  fs.rmSync(path.join(root, parts[0]), { recursive: true, force: true });
}

function evict(root: string): void {
  try {
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory() && UUID_RE.test(d.name))
      .map(d => { try { return { name: d.name, mtime: fs.statSync(path.join(root, d.name)).mtimeMs }; } catch { return null; } })
      .filter((x): x is { name: string; mtime: number } => !!x)
      .sort((a, b) => b.mtime - a.mtime);
    for (const d of dirs.slice(MAX_DIRS)) fs.rmSync(path.join(root, d.name), { recursive: true, force: true });
  } catch { /* 退场失败不影响本次写入 */ }
}

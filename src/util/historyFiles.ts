import * as path from 'path';
import * as fs from 'fs';
import { stripEnc } from './cipher';

/** Only roots of logical histories, never a transaction's temporary files. */
export function historyStemOf(file: string): string | null {
  const name = stripEnc(file);
  if (name.endsWith('.meta.json')) return name.slice(0, -10);
  if (name.endsWith('.rewrite.json')) return name.slice(0, -13);
  if (name.endsWith('.json') && !name.includes('.txn-')) return name.slice(0, -5);
  return null;
}

export function sessionIdOfStem(stem: string): string {
  return /^\d{4}-\d{2}-\d{2}_/.test(stem) ? stem.slice(11) : stem;
}

export function historySessionIds(files: string[]): Set<string> {
  return new Set(files.map(historyStemOf).filter((s): s is string => s !== null).map(sessionIdOfStem));
}

export function belongsToHistory(file: string, stem: string): boolean {
  const name = stripEnc(file);
  return name === stem || ['.json', '.jsonl', '.meta.json', '.rewrite.json', '.lock'].some(s => name === stem + s)
    || (name.startsWith(stem + '.agent-') && name.endsWith('.jsonl'))
    || name.startsWith(stem + '.lock.')
    || (name.startsWith(stem + '.txn-') && name.endsWith('.tmp'));
}

/**
 * 每组历史只 stat 一个文件：每次提交都会重写 meta，它就是这组的最新时间；
 * 没有 meta 的旧格式退回 .json。存在未完成的重写事务时把事务标记也算进来——
 * 崩溃在安装新 meta 之前时，标记比旧 meta 更能代表"这个会话最近被用过"。
 */
export function historyGroups(dir: string): Array<{ stem: string; mtime: number }> {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  const picked = new Map<string, { name: string | null; marker: string | null }>();
  for (const file of files) {
    const stem = historyStemOf(file);
    if (stem === null) continue;
    const entry = picked.get(stem) ?? { name: null, marker: null };
    const name = stripEnc(file);
    if (name.endsWith('.rewrite.json')) entry.marker = file;
    else if (entry.name === null || name.endsWith('.meta.json')) entry.name = file;
    picked.set(stem, entry);
  }
  return [...picked].map(([stem, { name, marker }]) => {
    const paths = [name, marker].filter((file): file is string => file !== null);
    return { stem, mtime: Math.max(...paths.map(file => fs.statSync(path.join(dir, file)).mtimeMs)) };
  });
}

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

export function historyGroups(dir: string): Array<{ stem: string; mtime: number }> {
  if (!fs.existsSync(dir)) return [];
  const groups = new Map<string, number>();
  for (const file of fs.readdirSync(dir)) {
    const stem = historyStemOf(file);
    if (stem !== null) groups.set(stem, Math.max(groups.get(stem) ?? 0, fs.statSync(path.join(dir, file)).mtimeMs));
  }
  return [...groups].map(([stem, mtime]) => ({ stem, mtime }));
}

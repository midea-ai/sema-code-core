import { Message } from '../types/message';
import { TodoItem } from '../events/types';
import { TodoTask } from '../types/todoTask';
import { GoalState } from '../types/goal';
import { logDebug, logInfo, logWarn } from './log';
import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir, getHistoryStem, getProjectHistoryDir, getProjectSnapshotsDir, getSnapshotsDir } from './savePath';
import { cleanupProjectSnapshots } from './snapshotStore';
import { collectProjectAttachmentIds, evictAttachments, releaseAttachmentIds, releaseSessionAttachments } from './attachmentLedger';
import { PER_PROJECT_HISTORY_LENGTH_LIMIT, PROJECT_LENGTH_LIMIT, HISTORY_CLEANUP_INTERVAL } from '../conf/config';
import { nowMillis } from './time';
import { getConfManager } from '../manager/ConfManager';
import { resolveSecurePath, stripEnc } from './cipher';
import { HistoryStore, releaseLock, tryLockHistory } from './historyStore';
import { belongsToHistory, historyGroups, historyStemOf, sessionIdOfStem } from './historyFiles';

export interface HistoryData {
  messages: Message[];
  todos: TodoItem[];
  todoTasks?: TodoTask[];
  readFileTimestamps?: Record<string, number>;
  goal?: GoalState;
}

export interface ResolvedHistoryFile {
  path: string;
  stem: string;
  noDate: boolean;
  exists: boolean;
  encrypted: boolean;
}

const stores = new Map<string, HistoryStore>();
const readers = new Map<string, number>();
const deferredRemovals = new Map<string, Array<() => void>>();
let lastHistoryCleanupTime = 0;
const directory = (projectPath?: string) => projectPath ? getProjectHistoryDir(projectPath) : getHistoryDir();
const keyOf = (id: string, projectPath?: string) => path.join(directory(projectPath), id);

function validateId(id: string): void {
  if (!id || id === '.' || id === '..' || /[\\/]/.test(id)) throw new Error('Invalid history session ID');
}

/** Resolve the logical stem once; a transaction takes precedence over either format. */
export function resolveHistoryFile(sessionId: string, projectPath?: string): ResolvedHistoryFile {
  validateId(sessionId);
  const inspect = (stem: string, noDate: boolean): ResolvedHistoryFile | undefined => {
    for (const suffix of ['.rewrite.json', '.meta.json', '.json', '.jsonl']) {
      const result = resolveSecurePath(stem + suffix);
      if (result.exists) return { ...result, stem, noDate };
    }
    return undefined;
  };
  const plain = getHistoryStem(sessionId, projectPath, true);
  const today = getHistoryStem(sessionId, projectPath, false);
  const direct = inspect(plain, true) ?? inspect(today, false);
  if (direct) return direct;
  const dir = directory(projectPath);
  let files: string[] = [];
  // 目录不存在或扫描途中被其他进程清理时按未命中处理，不让读取异常挡住会话创建
  try { files = fs.readdirSync(dir); } catch { /* 按未命中处理 */ }
  // Include orphan JSONL so missing metadata is reported, even across dates.
  const candidates = files.map(file => {
    const name = stripEnc(file);
    return { stem: name.endsWith('.jsonl') ? name.slice(0, -6) : historyStemOf(file), file };
  }).filter((g): g is { stem: string; file: string } => g.stem !== null && /^\d{4}-\d{2}-\d{2}_/.test(g.stem) && sessionIdOfStem(g.stem) === sessionId)
    // 条目在扫描途中被删除或不可读：跳过它，其他候选照常比较
    .flatMap(g => {
      try { return [{ ...g, mtime: fs.statSync(path.join(dir, g.file)).mtimeMs }]; } catch { return []; }
    }).sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    const result = inspect(path.join(dir, candidate.stem), false);
    if (result) return result;
  }
  return { ...resolveSecurePath(today + '.meta.json'), stem: today, noDate: false };
}

export function getHistoryStore(sessionId: string, projectPath?: string, noDate = false): HistoryStore {
  validateId(sessionId);
  const key = keyOf(sessionId, projectPath);
  let store = stores.get(key);
  if (!store) {
    const resolved = resolveHistoryFile(sessionId, projectPath);
    const stem = resolved.exists ? resolved.stem : getHistoryStem(sessionId, projectPath, noDate);
    store = new HistoryStore(stem, sessionId);
    stores.set(key, store);
  }
  return store;
}

export function closeHistory(sessionId: string, projectPath?: string): void {
  const key = keyOf(sessionId, projectPath);
  const store = stores.get(key);
  if (store) { store.close(); stores.delete(key); }
}

export async function loadHistory(sessionId?: string, projectPath?: string): Promise<HistoryData> {
  if (!sessionId) return { messages: [], todos: [] };
  try { return getHistoryStore(sessionId, projectPath, true).load(); }
  catch (error) { closeHistory(sessionId, projectPath); throw error; }
}

/** Synchronous commit: callers may await it, but dispose does not need an async queue. */
export function saveHistory(sessionId: string, messages: Message[], todos?: TodoItem[], projectPath?: string, readFileTimestamps?: Record<string, number>, todoTasks?: TodoTask[], noDate?: boolean, goal?: GoalState, replace = false): void {
  getHistoryStore(sessionId, projectPath, noDate).save({ messages, todos: todos ?? [], readFileTimestamps, todoTasks, goal }, replace);
  const now = nowMillis();
  if (now - lastHistoryCleanupTime > HISTORY_CLEANUP_INTERVAL) {
    lastHistoryCleanupTime = now;
    setImmediate(() => { void cleanupOldHistoryFiles(projectPath); });
  }
}

/** Prevent cleanup while an external hook is still reading the supplied paths. */
export function retainHistoryReader(stem: string): () => void {
  readers.set(stem, (readers.get(stem) ?? 0) + 1);
  return () => {
    const n = (readers.get(stem) ?? 1) - 1;
    if (n) readers.set(stem, n);
    else {
      readers.delete(stem);
      const removals = deferredRemovals.get(stem) ?? [];
      deferredRemovals.delete(stem);
      for (const remove of removals) {
        try { remove(); } catch (error) { logWarn(`清理子代理历史失败: ${error}`); }
      }
    }
  };
}

export function afterHistoryReaders(stem: string, remove: () => void): void {
  if (!readers.has(stem)) { remove(); return; }
  const pending = deferredRemovals.get(stem) ?? [];
  pending.push(remove);
  deferredRemovals.set(stem, pending);
}

type HeldLock = [stem: string, token: string];

/**
 * 接管目录里所有主干的写入锁：拿不到说明有活跃写入者（含正在重写事务中途的会话），返回 null。
 * 崩溃遗留的锁与重写意图不会被当成占用；成功后锁随目录一起删除，失败时调用 unlockDirectory 释放。
 */
function lockDirectory(dir: string): HeldLock[] | null {
  const held: HeldLock[] = [];
  const locked = new Set<string>();
  // 第二轮捡起拿到锁之后才出现的会话，缩小“新会话在删除途中开始写”的窗口
  for (let round = 0; round < 2; round++) {
    for (const file of fs.readdirSync(dir)) {
      const stem = file.endsWith('.lock') ? file.slice(0, -'.lock'.length) : historyStemOf(file);
      if (!stem || locked.has(stem)) continue;
      const fullStem = path.join(dir, stem);
      const token = tryLockHistory(fullStem);
      if (!token) { unlockDirectory(held); return null; }
      locked.add(stem);
      held.push([fullStem, token]);
    }
  }
  return held;
}

function unlockDirectory(held: HeldLock[]): void {
  for (const [stem, token] of held) releaseLock(stem + '.lock', token);
}

function removeGroup(dir: string, stem: string): boolean {
  const fullStem = path.join(dir, stem);
  if (readers.has(fullStem)) return false;
  // 删除期间持锁，别的进程既写不进这个会话，也删不掉它
  const token = tryLockHistory(fullStem);
  if (!token) return false;
  const lock = path.basename(fullStem) + '.lock';
  try {
    // Remove data before the root metadata, so a failed delete keeps ownership alive.
    const files = fs.readdirSync(dir).filter(f => f !== lock && belongsToHistory(f, stem));
    files.sort((a, b) => Number(historyStemOf(a) !== null) - Number(historyStemOf(b) !== null));
    for (const file of files) fs.rmSync(path.join(dir, file), { recursive: true, force: true });
  } finally { releaseLock(fullStem + '.lock', token); }
  return true;
}

function cleanupProjectHistoryFiles(dir: string): void {
  try {
    const groups = historyGroups(dir).filter(g => /^\d{4}-\d{2}-\d{2}_/.test(g.stem)).sort((a, b) => b.mtime - a.mtime);
    const deleted: string[] = [];
    for (const group of groups.slice(PER_PROJECT_HISTORY_LENGTH_LIMIT)) {
      const stem = path.join(dir, group.stem);
      if ([...stores.values()].some(s => s.stem === stem)) continue;
      if (removeGroup(dir, group.stem)) deleted.push(sessionIdOfStem(group.stem));
    }
    releaseSessionAttachments(dir, deleted);
  } catch (error) { logWarn(`清理历史失败: ${error}`); }
}

function cleanupInactiveProjects(): void {
  const historyDir = getHistoryDir();

  try {
    if (!fs.existsSync(historyDir)) {
      return;
    }

    const entries = fs.readdirSync(historyDir, { withFileTypes: true });
    const projectDirs = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('-'));

    if (projectDirs.length <= PROJECT_LENGTH_LIMIT) {
      return;
    }

    // 获取每个项目目录的最新文件修改时间
    const dirsWithStats = projectDirs.map(dir => {
      const dirPath = path.join(historyDir, dir.name);
      let latestMtime = new Date(0);

      try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          if (stripEnc(file).endsWith('.json')) {
            const stats = fs.statSync(path.join(dirPath, file));
            if (stats.mtime > latestMtime) {
              latestMtime = stats.mtime;
            }
          }
        }
      } catch {
        // 读取失败使用最早时间
      }

      return { name: dir.name, path: dirPath, mtime: latestMtime };
    });

    dirsWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const dirsToDelete = dirsWithStats.slice(PROJECT_LENGTH_LIMIT).filter(dir =>
      ![...stores.values()].some(s => path.dirname(s.stem) === dir.path) && ![...readers.keys()].some(s => path.dirname(s) === dir.path));

    for (const dir of dirsToDelete) {
      const held = lockDirectory(dir.path);
      if (!held) continue;
      // 附件跟随会话退场：清单在历史目录里，删除前先读出登记的附件；目录删除成功后才释放，删除失败时附件原样保留
      const attachmentIds = collectProjectAttachmentIds(dir.path);
      try {
        fs.rmSync(dir.path, { recursive: true, force: true });
        logDebug(`删除不活跃项目历史目录: ${dir.name}`);
        releaseAttachmentIds(attachmentIds);
      } catch (deleteError) {
        unlockDirectory(held);
        logWarn(`删除项目历史目录失败 ${dir.name}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
        continue;
      }

      // 同步删除对应的同名快照目录，避免遗留无主 editlog / blob
      // （snapshots 与 history 共用项目目录名，仅根目录不同）
      const snapshotDir = path.join(getSnapshotsDir(), dir.name);
      try {
        if (fs.existsSync(snapshotDir)) {
          fs.rmSync(snapshotDir, { recursive: true, force: true });
          logDebug(`删除不活跃项目快照目录: ${dir.name}`);
        }
      } catch (deleteError) {
        logWarn(`删除项目快照目录失败 ${dir.name}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
      }
    }

    if (dirsToDelete.length > 0) {
      logDebug(`项目目录清理完成，删除了 ${dirsToDelete.length} 个不活跃项目`);
    }
  } catch (error) {
    logWarn(`清理项目目录失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function cleanupOldHistoryFiles(projectPath?: string): Promise<void> {
  if (projectPath) {
    cleanupProjectHistoryFiles(getProjectHistoryDir(projectPath));
    cleanupProjectSnapshots(projectPath);
  }
  cleanupInactiveProjects();
  evictAttachments();
}

function resolveProjectPath(projectPath: string | undefined): string | undefined {
  return projectPath || getConfManager().getCoreConfig()?.workingDir || undefined;
}

export function deleteProjectHistory(projectPath?: string): void {
  try {
    const target = resolveProjectPath(projectPath);
    if (!target) return;
    const dir = getProjectHistoryDir(target);
    if ([...readers.keys()].some(s => path.dirname(s) === dir)) throw new Error('History is being read by a hook');
    for (const [key, store] of stores) {
      if (path.dirname(store.stem) === dir) { store.close(); stores.delete(key); }
    }
    const held = fs.existsSync(dir) ? lockDirectory(dir) : [];
    if (!held) throw new Error('Project history is still in use');
    const ids = collectProjectAttachmentIds(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      releaseAttachmentIds(ids);
    } catch (error) {
      unlockDirectory(held);
      throw error;
    }
    fs.rmSync(getProjectSnapshotsDir(target), { recursive: true, force: true });
  } catch (error) { logWarn(`删除历史失败: ${error}`); }
}

export function deleteSessionHistory(sessionId: string, projectPath?: string): void {
  try {
    const target = resolveProjectPath(projectPath);
    if (!target) return;
    validateId(sessionId);
    const dir = directory(target);
    if (!fs.existsSync(dir)) return;
    const stems = new Set([sessionId, ...historyGroups(dir).map(g => g.stem).filter(s => sessionIdOfStem(s) === sessionId)]);
    if ([...stems].some(s => readers.has(path.join(dir, s)))) throw new Error('History is being read by a hook');
    closeHistory(sessionId, target);
    for (const stem of stems) {
      if (!removeGroup(dir, stem)) logWarn(`会话历史仍被其他进程写入，保留: ${path.join(dir, stem)}`);
    }
    releaseSessionAttachments(dir, [sessionId]);
    cleanupProjectSnapshots(target);
  } catch (error) { logWarn(`删除历史失败: ${error}`); }
}

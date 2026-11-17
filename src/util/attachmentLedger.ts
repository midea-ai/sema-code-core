/**
 * 附件归属清单与退场。
 *
 * 附件放在 <semaRoot>/attachments/<id>/ 下，目录本身不带归属。归属记在会话历史目录里的清单文件
 * <会话id>.attachments（每行一个附件目录名，只追加），附件经过 core 的那一刻登记：
 * 附图原图 / 生成图落盘、写文件工具写进附件目录、用户消息引用了附件目录下的文件。
 *
 * 退场三条规则，都在这里：
 * - 跟随会话：会话历史被删除 / 清理时，清单里没有被其他会话登记的附件一起删（releaseSessionAttachments）
 * - 期限兜底：未登记的附件，超过期限且排在最新若干个之外才删（evictAttachments）
 * - 体积上限：总体积超限时从最旧的删起，先删未登记的（evictAttachments）
 */
import * as fs from 'fs';
import * as path from 'path';
import { getAttachmentsDir, getHistoryDir, getProjectHistoryDir } from './savePath';
import { getConfManager } from '../manager/ConfManager';
import { stripEnc } from './cipher';
import { logDebug, logWarn } from './log';
import {
  ATTACHMENTS_RETAIN_COUNT,
  ATTACHMENTS_RETAIN_MS,
  ATTACHMENTS_MAX_BYTES,
  ATTACHMENTS_EMPTY_DIR_TTL,
  ATTACHMENT_LEDGER_ORPHAN_TTL
} from '../conf/config';

const LEDGER_EXT = '.attachments';
// 与各宿主识别附件路径用的形状一致（36 位十六进制加连字符）
const ID_RE = /^[0-9a-f-]{36}$/i;

// 本进程已知的各会话登记内容：首次登记时从清单文件读入，之后只在内存里判重，避免重复追加
const known = new Map<string, Set<string>>();

/** 清单所在目录：与会话历史文件同目录 */
function ledgerDir(projectPath?: string): string {
  return projectPath ? getProjectHistoryDir(projectPath) : getHistoryDir();
}

function currentProjectPath(): string | undefined {
  return getConfManager().getCoreConfig()?.workingDir;
}

function readLedger(file: string): Set<string> {
  try {
    return new Set(fs.readFileSync(file, 'utf8').split('\n').map(line => line.trim()).filter(line => ID_RE.test(line)));
  } catch {
    return new Set();
  }
}

function idUnder(root: string, target: string): string | null {
  const parts = path.relative(root, target).split(path.sep);
  return parts.length >= 2 && ID_RE.test(parts[0]) ? parts[0] : null;
}

/** 路径位于附件目录的某个 <id>/ 之下时返回该 id，否则 null（~/.sema 是符号链接时按真实路径再比一次） */
export function attachmentIdOf(filePath: string): string | null {
  const root = getAttachmentsDir();
  const abs = path.resolve(filePath);
  const direct = idUnder(root, abs);
  if (direct) return direct;
  try {
    return idUnder(fs.realpathSync(root), fs.realpathSync(abs));
  } catch {
    return null;
  }
}

/**
 * 把附件登记到会话名下。路径不在附件目录下时什么都不做；失败只记日志，不影响调用方
 */
export function registerAttachment(sessionId: string | undefined, filePath: string | null | undefined, projectPath?: string): void {
  if (!sessionId || !filePath) return;
  try {
    const id = attachmentIdOf(filePath);
    if (!id) return;
    const dir = ledgerDir(projectPath ?? currentProjectPath());
    const file = path.join(dir, `${sessionId}${LEDGER_EXT}`);
    let ids = known.get(file);
    // 清单可能已被别的进程随会话删除：文件不在时内存里的判重结果作废
    if (!ids || !fs.existsSync(file)) {
      ids = readLedger(file);
      known.set(file, ids);
    }
    if (ids.has(id)) return;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${id}\n`);
    ids.add(id);
  } catch (error) {
    logWarn(`附件登记失败 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 分支出新会话时复制清单：新会话的历史里带着原会话的附件路径 */
export function copyAttachmentLedger(fromSessionId: string, toSessionId: string, projectPath?: string): void {
  try {
    const dir = ledgerDir(projectPath ?? currentProjectPath());
    const ids = readLedger(path.join(dir, `${fromSessionId}${LEDGER_EXT}`));
    if (ids.size === 0) return;
    const target = path.join(dir, `${toSessionId}${LEDGER_EXT}`);
    const merged = new Set([...readLedger(target), ...ids]);
    fs.writeFileSync(target, [...merged].map(id => `${id}\n`).join(''));
    known.set(target, merged);
  } catch (error) {
    logWarn(`复制附件清单失败 ${fromSessionId} -> ${toSessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 历史目录里有历史文件的会话 id：<会话id>.json 或 YYYY-MM-DD_<会话id>.json，均可带 .enc */
function sessionsWithHistory(files: string[]): Set<string> {
  const sessions = new Set<string>();
  for (const file of files) {
    const name = stripEnc(file);
    if (!name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    sessions.add(stem);
    if (/^\d{4}-\d{2}-\d{2}_/.test(stem)) sessions.add(stem.slice(11));
  }
  return sessions;
}

/**
 * 汇总所有项目的清单，返回已登记的附件 id。
 * 清单没有对应的会话历史且超过 ATTACHMENT_LEDGER_ORPHAN_TTL 的不算数（附件登记后会话没留下历史），
 * pruneStale 为 true 时顺带删掉这种清单；期限内的照常算数，保护首条消息带附件、历史尚未落盘的新会话
 */
export function collectRegisteredIds(pruneStale = false): Set<string> {
  const registered = new Set<string>();
  const root = getHistoryDir();
  let dirs: string[] = [];
  try {
    dirs = [root, ...fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))];
  } catch {
    return registered;
  }
  const now = Date.now();
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const ledgers = files.filter(file => file.endsWith(LEDGER_EXT));
    if (ledgers.length === 0) continue;
    const alive = sessionsWithHistory(files);
    for (const ledger of ledgers) {
      const file = path.join(dir, ledger);
      if (!alive.has(ledger.slice(0, -LEDGER_EXT.length))) {
        let stale = false;
        try {
          stale = now - fs.statSync(file).mtimeMs > ATTACHMENT_LEDGER_ORPHAN_TTL;
        } catch {
          continue;
        }
        if (stale) {
          if (pruneStale) {
            try { fs.unlinkSync(file); } catch { /* 下次再删 */ }
            known.delete(file);
          }
          continue;
        }
      }
      for (const id of readLedger(file)) registered.add(id);
    }
  }
  return registered;
}

/** 删除一个附件目录：只接受 id 形状的名字，且必须落在附件根目录内 */
function removeAttachmentDir(id: string): void {
  if (!ID_RE.test(id)) return;
  const root = getAttachmentsDir();
  const dir = path.join(root, id);
  if (path.dirname(dir) !== root) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    logDebug(`删除附件目录: ${id}`);
  } catch (error) {
    logWarn(`删除附件目录失败 ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 会话历史已删除后调用：这些会话清单里的附件，没有被任何其他会话登记的一起删，清单文件随之删除。
 * 会话没有清单时不产生目录扫描。
 * requireHistoryGone（默认开）：目录里仍有该会话的历史文件时跳过——历史文件没删成功，或同一会话还有另一份历史
 */
export function releaseSessionAttachments(historyDir: string, sessionIds: string[], requireHistoryGone = true): void {
  try {
    const ledgers = sessionIds
      .map(sessionId => ({ sessionId, file: path.join(historyDir, `${sessionId}${LEDGER_EXT}`) }))
      .filter(ledger => fs.existsSync(ledger.file));
    if (ledgers.length === 0) return;
    const alive = requireHistoryGone ? sessionsWithHistory(fs.readdirSync(historyDir)) : new Set<string>();
    const candidates = new Set<string>();
    for (const { sessionId, file } of ledgers) {
      if (alive.has(sessionId)) continue;
      for (const id of readLedger(file)) candidates.add(id);
      // 先删清单再汇总，汇总结果里就不含被删会话自己
      fs.unlinkSync(file);
      known.delete(file);
    }
    releaseAttachmentIds(candidates);
  } catch (error) {
    logWarn(`清理会话附件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 删除给定附件里没有被任何现存清单登记的；调用前这些附件原属的清单必须已经不在 */
export function releaseAttachmentIds(ids: Set<string>): void {
  if (ids.size === 0) return;
  try {
    const others = collectRegisteredIds();
    for (const id of ids) {
      if (!others.has(id)) removeAttachmentDir(id);
    }
  } catch (error) {
    logWarn(`清理附件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * /clear 后调用：会话还在但对话已清空，界面和模型上下文里都不再有这些附件，
 * 本会话登记的附件按删会话的规则清理，清单从空开始重新登记
 */
export function releaseClearedSessionAttachments(sessionId: string, projectPath?: string): void {
  try {
    releaseSessionAttachments(ledgerDir(projectPath ?? currentProjectPath()), [sessionId], false);
  } catch (error) {
    logWarn(`清理会话附件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 整个项目的历史目录被删除前调用：读出该目录下所有清单登记的附件，不删任何东西。
 * 清单随目录一起消失，所以要先读；调用方在目录删除成功之后再调 releaseAttachmentIds，
 * 目录没删掉（文件被占用、无权限）时不释放，留下的历史不会丢附件
 */
export function collectProjectAttachmentIds(historyDir: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const file of fs.readdirSync(historyDir)) {
      if (!file.endsWith(LEDGER_EXT)) continue;
      for (const id of readLedger(path.join(historyDir, file))) ids.add(id);
    }
  } catch {
    // 目录不存在或读取失败：没有可释放的
  }
  return ids;
}

export interface AttachmentEvictLimits {
  retainCount: number;
  retainMs: number;
  maxBytes: number;
  emptyDirTtl: number;
}

const DEFAULT_LIMITS: AttachmentEvictLimits = {
  retainCount: ATTACHMENTS_RETAIN_COUNT,
  retainMs: ATTACHMENTS_RETAIN_MS,
  maxBytes: ATTACHMENTS_MAX_BYTES,
  emptyDirTtl: ATTACHMENTS_EMPTY_DIR_TTL
};

function dirSize(dir: string): { bytes: number; empty: boolean } {
  let bytes = 0;
  let empty = true;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    empty = false;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += dirSize(full).bytes;
    else if (entry.isFile()) bytes += fs.statSync(full).size;
  }
  return { bytes, empty };
}

/**
 * 附件目录的兜底清理，随历史清理触发（每小时至多一次）：
 * 1) 空目录存在超过 emptyDirTtl 删除
 * 2) 期限兜底：全部附件目录按修改时间从新到旧排序，未登记、排在 retainCount 之外且超过 retainMs 的删除；
 *    已登记的参与排名但不删，它们只跟随会话
 * 3) 体积上限：剩余总体积超过 maxBytes 时从最旧的删起，先删未登记的，不够再删已登记的
 */
export function evictAttachments(limits: AttachmentEvictLimits = DEFAULT_LIMITS): void {
  try {
    const root = getAttachmentsDir();
    if (!fs.existsSync(root)) return;
    const registered = collectRegisteredIds(true);
    const now = Date.now();

    const dirs: Array<{ id: string; mtime: number; bytes: number; registered: boolean }> = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      try {
        const full = path.join(root, entry.name);
        const mtime = fs.statSync(full).mtimeMs;
        const { bytes, empty } = dirSize(full);
        if (empty) {
          if (now - mtime > limits.emptyDirTtl) removeAttachmentDir(entry.name);
          continue;
        }
        dirs.push({ id: entry.name, mtime, bytes, registered: registered.has(entry.name) });
      } catch {
        // 读取期间目录被别的进程删掉，跳过
      }
    }

    dirs.sort((a, b) => b.mtime - a.mtime);
    const kept = dirs.filter((dir, index) => {
      if (dir.registered || index < limits.retainCount || now - dir.mtime <= limits.retainMs) return true;
      removeAttachmentDir(dir.id);
      return false;
    });

    let total = kept.reduce((sum, dir) => sum + dir.bytes, 0);
    if (total <= limits.maxBytes) return;
    // kept 仍是从新到旧，倒过来即从旧到新；未登记的排在已登记的前面先删
    const oldestFirst = [...kept].reverse();
    const order = [...oldestFirst.filter(dir => !dir.registered), ...oldestFirst.filter(dir => dir.registered)];
    for (const dir of order) {
      if (total <= limits.maxBytes) break;
      removeAttachmentDir(dir.id);
      total -= dir.bytes;
    }
  } catch (error) {
    logWarn(`附件兜底清理失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

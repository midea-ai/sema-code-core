/**
 * 会话 Fork 文件级快照管理（单例）
 *
 * 职责：
 * - 维护每会话的 EditLog（文件"改动前镜像"的追加日志），通过 snapshotStore 持久化
 * - 提供 fork 预览（preview）、回滚计划（computeRestorePlan）与回滚执行（applyRestore）
 * - 原地回退时截断 EditLog（truncateEditLog）
 * - 对外提供会话基线 diff：文件清单（getFileChanges）、单文件详情（getFileDiff）与
 *   「放弃修改」（revertFileChanges）。会话基线 = 有效 EditLog 中该文件最早一条改前镜像
 *
 * 设计要点见计划：每文件每 turn-segment 只捕获一次；失败关闭（fail-closed）；
 * 回滚按字节级整文件还原；不处理外部修改冲突。
 * blob/editlog 的文件 IO 与退场清理在 util/snapshotStore.ts（纯 IO，避免循环依赖）。
 */

import { existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { isAbsolute, dirname, resolve } from 'path';
import { getConfManager } from './ConfManager';
import { getStateManager } from './StateManager';
import { canonicalizeFilePath, getDisplayPath, isBinaryFile, readTextContent } from '../util/file';
import { diffContents, countPatchLines, diffStats } from '../util/diff';
import {
  EditRecord,
  loadEditLog,
  saveEditLog,
  readBlob,
  tryReadBlob,
  writeBlobFromFile,
} from '../util/snapshotStore';
import { UserMsg } from '../types/message';
import { ForkPreview, ForkFileChange, ForkFileEffect } from '../types/fork';
import { FileChangeItem, FileChangeState, FileChangeStatus, FileDiffResult, RevertFileResult } from '../types/fileChange';

/**
 * 文本比较上限：超过的文件不做全文 diff，只表达状态（基线与 blob 都还在）。
 * 取 1MB：读盘与 diff 都随大小线性增长，再大一次刷新就会明显占住事件循环。
 */
const MAX_TEXT_DIFF_BYTES = 1024 * 1024;

/** 单文件快照捕获上限的缺省值；core 配置 maxCheckpointBytes 可覆盖，0 为不限制 */
const DEFAULT_MAX_CHECKPOINT_BYTES = 10 * 1024 * 1024;

/**
 * 从字节判断文本编码：BOM 优先，其次看无 BOM UTF-16LE 的典型特征（奇数字节大量为 0）。
 * 只判定 utf16le / utf8（与 core 其它读文件路径一致，utf16be 仍按 utf8 处理）。
 */
function detectEncoding(bytes: Buffer): BufferEncoding {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf16le';
  const sample = bytes.subarray(0, 256); // 只看头部，长文件不全量扫描
  if (sample.length >= 4) {
    let pairs = 0;
    let zeroOdd = 0;
    for (let i = 0; i + 1 < sample.length; i += 2) {
      pairs++;
      if (sample[i + 1] === 0 && sample[i] !== 0) zeroOdd++;
    }
    if (zeroOdd / pairs > 0.6) return 'utf16le';
  }
  return 'utf8';
}

/** 回滚计划项 */
export interface RestorePlanItem {
  filePath: string;
  blobHash: string | null;
  existedBefore: boolean;
}

class CheckpointManager {
  // 每会话内存中的 EditLog（懒加载自磁盘）
  private editLogs: Map<string, EditRecord[]> = new Map();
  // 每会话当前 turn-segment 起始 seq（beginTurn 时设置）
  private segmentStarts: Map<string, number> = new Map();

  private projectPath(): string | undefined {
    return getConfManager().getCoreConfig()?.workingDir;
  }

  /** 单文件捕获上限（字节）；配置缺省 10MB，0 / 负数表示不限制 */
  private maxCheckpointBytes(): number {
    const configured = getConfManager().getCoreConfig()?.maxCheckpointBytes;
    const cap = configured ?? DEFAULT_MAX_CHECKPOINT_BYTES;
    return cap > 0 ? cap : Number.POSITIVE_INFINITY;
  }

  private getEditLog(sessionId: string): EditRecord[] {
    let log = this.editLogs.get(sessionId);
    if (!log) {
      log = loadEditLog(sessionId, this.projectPath());
      this.editLogs.set(sessionId, log);
    }
    return log;
  }

  private persist(sessionId: string): void {
    saveEditLog(sessionId, this.editLogs.get(sessionId) ?? [], this.projectPath());
  }

  /** 读 blob 并按 LF 归一化为文本（仅用于预览的行数/diff，回滚仍用原始字节） */
  private readBlobText(hash: string): string {
    return readBlob(hash, this.projectPath()).toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  // ============================================================
  // turn 锚点
  // ============================================================

  /** 开始一个新的 turn：返回当前 EditLog 长度并设为本 segment 起点 */
  beginTurn(sessionId: string): number {
    const seq = this.getEditLog(sessionId).length;
    this.segmentStarts.set(sessionId, seq);
    return seq;
  }

  /** 当前 EditLog 记录数（= 下一条 fork 锚点值） */
  getEditCount(sessionId: string): number {
    return this.getEditLog(sessionId).length;
  }

  // ============================================================
  // 捕获（存的入口）— fail-closed
  // ============================================================

  /**
   * 在工具写盘前记录文件的"改动前镜像"。
   * 失败关闭：捕获失败抛错，由调用方令本次工具调用失败（不写盘）。
   */
  recordPreEdit(sessionId: string, agentId: string, fullFilePath: string): void {
    try {
      const log = this.getEditLog(sessionId);
      const segStart = this.segmentStarts.get(sessionId) ?? 0;

      // 去重：该文件在当前 segment 已捕获过段起始镜像
      if (log.some(r => r.filePath === fullFilePath && r.seq >= segStart)) {
        return;
      }

      const existedBefore = existsSync(fullFilePath);
      let blobHash: string | null = null;
      let oversized = false;
      if (existedBefore) {
        // 超过上限只跳过内容快照（软降级），不阻塞写盘；读大小出错仍按 fail-closed 走 catch
        const cap = this.maxCheckpointBytes();
        if (statSync(fullFilePath).size > cap) {
          oversized = true;
        } else {
          blobHash = writeBlobFromFile(fullFilePath, this.projectPath());
        }
      }

      log.push({
        seq: log.length,
        agentId,
        filePath: fullFilePath,
        blobHash,
        existedBefore,
        ...(oversized ? { oversized: true as const } : {}),
        ts: Date.now(),
      });
      this.persist(sessionId);
    } catch (error) {
      throw new Error(
        `Failed to capture checkpoint before editing ${fullFilePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ============================================================
  // 回滚计划 / 预览 / 执行
  // ============================================================

  /**
   * 选取回滚集：seq >= forkSeq 的记录中，每个文件取最早的一条。
   * 改前内容超限未保存的文件无从还原，整条跳过（不回退，也不拿更晚的快照代替）。
   */
  computeRestorePlan(sessionId: string, forkSeq: number): RestorePlanItem[] {
    const log = this.getEditLog(sessionId);
    const byFile = new Map<string, EditRecord>();
    for (const r of log) {
      if (r.seq < forkSeq) continue;
      const existing = byFile.get(r.filePath);
      if (!existing || r.seq < existing.seq) {
        byFile.set(r.filePath, r);
      }
    }
    return Array.from(byFile.values())
      .filter(r => !r.oversized)
      .map(r => ({
        filePath: r.filePath,
        blobHash: r.blobHash,
        existedBefore: r.existedBefore,
      }));
  }

  /** 预览：在 messageUuid 处恢复文件会改动哪些文件、各自增删行数（只读） */
  preview(sessionId: string, messageUuid: string): ForkPreview {
    const history = getStateManager().session(sessionId).getMessageHistory();
    const msg = history.find(m => m.type === 'user' && m.uuid === messageUuid) as UserMsg | undefined;
    const forkSeq = msg?.checkpointSeq;

    if (!msg || forkSeq === undefined) {
      return { messageUuid, canRestoreFiles: false, files: [] };
    }

    const plan = this.computeRestorePlan(sessionId, forkSeq);
    const files = plan.map(p => this.describeChange(p));
    return { messageUuid, canRestoreFiles: true, files };
  }

  /** 执行回滚（仅 fork(restoreFiles:true) 调用）。返回实际处理的文件路径。 */
  applyRestore(plan: RestorePlanItem[]): string[] {
    const restored: string[] = [];
    for (const p of plan) {
      if (!p.existedBefore) {
        // fork 后才新建的文件 → 删除以回到 fork 态；已被外部删则视为已达成
        try {
          if (existsSync(p.filePath)) unlinkSync(p.filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
        }
      } else {
        // 改前内容未保存（超限）的项不该进 plan；防御性跳过，不写坏文件
        if (!p.blobHash) continue;
        const buf = readBlob(p.blobHash, this.projectPath());
        mkdirSync(dirname(p.filePath), { recursive: true });
        writeFileSync(p.filePath, buf); // 字节级还原
      }
      restored.push(p.filePath);
    }
    return restored;
  }

  /** 原地回退时把 seq >= forkSeq 的记录截掉（被撤销的快照记录丢弃） */
  truncateEditLog(sessionId: string, forkSeq: number): void {
    const kept = this.getEditLog(sessionId).filter(r => r.seq < forkSeq);
    this.editLogs.set(sessionId, kept);
    this.segmentStarts.set(sessionId, kept.length);
    this.persist(sessionId);
  }

  /**
   * 分支到新聊天：把源会话 seq < uptoSeq 的 EditLog 记录复制为目标会话的 editlog。
   * blobs 内容寻址、跨会话共享，无需复制；目标会话打开后自行懒加载。
   */
  copyEditLog(srcSessionId: string, destSessionId: string, uptoSeq: number): void {
    const kept = this.getEditLog(srcSessionId).filter(r => r.seq < uptoSeq);
    saveEditLog(destSessionId, kept, this.projectPath());
  }

  /** 释放某会话的内存 EditLog（磁盘文件保留，供重新打开/再次 fork 使用） */
  forgetSession(sessionId: string): void {
    this.editLogs.delete(sessionId);
    this.segmentStarts.delete(sessionId);
  }

  /**
   * 清空某会话的基线（/clear 清空会话历史时调用）：
   * 历史没了，基线也应随之作废，否则文件变更面板会把清空前的改动重新列出来。
   * blob 不立即删，交给历史清理时的引用计数回收。
   */
  clearEditLog(sessionId: string): void {
    this.editLogs.set(sessionId, []);
    this.segmentStarts.set(sessionId, 0);
    this.persist(sessionId);
  }

  // ============================================================
  // 会话基线 diff（文件变更面板 / 动态 diff / 放弃修改）
  // ============================================================

  /**
   * 本会话的有效基线：每个文件取 EditLog 中最早的一条改前镜像。
   * log 按 seq 递增，所以首个命中即最早；回退截断后自然跟随剩余记录。
   */
  private baselines(sessionId: string): Map<string, EditRecord> {
    const byFile = new Map<string, EditRecord>();
    for (const r of this.getEditLog(sessionId)) {
      if (!byFile.has(r.filePath)) byFile.set(r.filePath, r);
    }
    return byFile;
  }

  /**
   * 会话相关文件清单，已过滤掉确认与基线一致的文件。
   * 无法判断差异的（二进制 / 超限 / 基线不可读 / 当前不可读）保留条目并标记 status，
   * 由产品展示状态、不显示增删数字。
   *
   * 逐个文件顺序处理：文本比较要读全文，并发读会把多个大文件同时留在内存里。
   */
  async getFileChanges(sessionId: string): Promise<FileChangeItem[]> {
    const items: FileChangeItem[] = [];
    for (const record of this.baselines(sessionId).values()) {
      const diff = await this.inspect(record);
      if (diff.state === 'unchanged') continue;
      items.push(this.toItem(diff));
    }
    return items;
  }

  /** 单文件：会话基线 → 查询时磁盘内容 */
  async getFileDiff(sessionId: string, filePath: string): Promise<FileDiffResult> {
    const record = this.lookup(this.baselines(sessionId), filePath);
    if (record) return this.inspect(record);

    // 没有记录（从未受控写入 / 旧会话无 editlog）：不构造空基线，只报告当前是否存在
    const abs = canonicalizeFilePath(filePath);
    let currentExists = false;
    try { currentExists = (await stat(abs)).isFile(); } catch { /* 不存在或读不到 */ }
    return {
      filePath: abs,
      displayPath: getDisplayPath(abs),
      state: 'unknown',
      status: 'baselineUnavailable',
      baselineExists: false,
      currentExists,
    };
  }

  /**
   * 放弃修改：把文件恢复到会话基线。不传 filePaths 才处理全部相关文件；
   * 显式传空数组表示"什么都没选"，直接返回空结果、不碰磁盘。
   * 基线不存在的文件删除、存在的按原始字节写回；单文件失败不影响其余文件。
   */
  async revertFileChanges(sessionId: string, filePaths?: string[]): Promise<RevertFileResult[]> {
    const baselines = this.baselines(sessionId);
    const targets = filePaths === undefined
      ? Array.from(baselines.values())
      : filePaths.map(p => this.lookup(baselines, p)).filter((r): r is EditRecord => !!r);

    const results: RevertFileResult[] = [];
    for (const record of targets) {
      const base = { filePath: record.filePath, displayPath: getDisplayPath(record.filePath) };
      try {
        if (!record.existedBefore) {
          await rm(record.filePath, { force: true });
          results.push({ ...base, action: 'deleted' });
        } else if (!record.blobHash) {
          // 改前内容超限未保存：没有可写回的基线，不能当新建文件删掉
          results.push({ ...base, action: 'failed', error: 'baseline content not captured (file exceeds maxCheckpointBytes)' });
        } else {
          const buf = readBlob(record.blobHash, this.projectPath());
          await mkdir(dirname(record.filePath), { recursive: true });
          await writeFile(record.filePath, buf);
          results.push({ ...base, action: 'restored' });
        }
      } catch (error) {
        results.push({ ...base, action: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  /**
   * 把宿主传来的文件路径对到记录：新工具事件给的是展示路径（项目内相对初始 cwd），
   * 也可能直接给绝对路径或相对工作目录的路径，三种写法都接受。
   */
  private lookup(baselines: Map<string, EditRecord>, filePath: string): EditRecord | undefined {
    const direct = baselines.get(canonicalizeFilePath(filePath));
    if (direct || isAbsolute(filePath)) return direct;
    const workingDir = this.projectPath();
    return workingDir ? baselines.get(canonicalizeFilePath(resolve(workingDir, filePath))) : undefined;
  }

  /** 单文件基线比较：决定状态、能否文本比较，以及可比较时的左右文本、hunks 与统计 */
  private async inspect(record: EditRecord): Promise<FileDiffResult> {
    const { filePath } = record;
    const baselineExists = record.existedBefore;

    // 当前文件：ENOENT 表示确实不存在；权限 / 父目录不可访问等错误说明"读不出来"，
    // 不能当成不存在——否则会把已有基线的文件报成已删除，或把新建文件当成未变化被过滤掉
    let currentExists = false;
    let existenceKnown = true;
    let currentProblem: FileChangeStatus | null = null;
    try {
      const info = await stat(filePath);
      currentExists = true;
      if (!info.isFile()) currentProblem = 'currentUnreadable';
      else if (info.size > MAX_TEXT_DIFF_BYTES) currentProblem = 'tooLarge';
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        currentExists = false;
      } else {
        existenceKnown = false;
        currentProblem = 'currentUnreadable';
      }
    }

    const state: FileChangeState = !existenceKnown
      ? 'unknown'
      : !baselineExists
        ? (currentExists ? 'added' : 'unchanged')
        : (currentExists ? 'modified' : 'deleted');
    const plain = (status: FileChangeStatus): FileDiffResult =>
      ({ filePath, displayPath: getDisplayPath(filePath), state, status, baselineExists, currentExists });

    if (currentProblem) return plain(currentProblem);
    if (isBinaryFile(filePath)) return plain('binary');

    let baseBytes: Buffer | null = null;
    if (baselineExists) {
      baseBytes = record.blobHash ? tryReadBlob(record.blobHash, this.projectPath()) : null;
      if (!baseBytes) return plain('baselineUnavailable');
      if (baseBytes.length > MAX_TEXT_DIFF_BYTES) return plain('tooLarge');
    }

    let currentBytes = Buffer.alloc(0);
    if (currentExists) {
      try {
        currentBytes = await readFile(filePath);
      } catch {
        return plain('currentUnreadable');
      }
      if (currentBytes.length > MAX_TEXT_DIFF_BYTES) return plain('tooLarge');
    }

    const baselineText = baseBytes ? this.decodeBytes(baseBytes) : '';
    const currentText = this.decodeBytes(currentBytes);
    const { hunks, additions, removals, line } = diffStats(filePath, baselineText, currentText);
    // 字节相同即无变化；文本零增删但字节不同 = 编码 / BOM / 换行形式变化
    const bytesDiffer = !!baseBytes && currentExists
      && createHash('sha256').update(currentBytes).digest('hex') !== record.blobHash;
    const rawChanged = bytesDiffer && additions === 0 && removals === 0;

    return {
      ...plain('ok'),
      state: baselineExists && currentExists && !bytesDiffer ? 'unchanged' : state,
      baselineText,
      currentText,
      hunks,
      additions,
      removals,
      line,
      ...(rawChanged ? { rawChanged: true } : {}),
    };
  }

  /**
   * 原始字节按编码解码并统一按 LF 比较（展示用；恢复仍用原始字节）。
   * 两侧都按字节判断编码，不查路径编码缓存——文件可能已被保存成另一种编码，
   * 按路径缓存的旧结果会把当前内容或基线解成乱码。
   */
  private decodeBytes(bytes: Buffer): string {
    return bytes.toString(detectEncoding(bytes)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  private toItem(diff: FileDiffResult): FileChangeItem {
    const { filePath, displayPath, state, status, baselineExists, additions, removals, line, rawChanged } = diff;
    return {
      filePath,
      displayPath,
      state,
      status,
      baselineExists,
      ...(additions !== undefined ? { additions } : {}),
      ...(removals !== undefined ? { removals } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(rawChanged ? { rawChanged } : {}),
    };
  }

  // ============================================================
  // 内部：描述单文件改动
  // ============================================================

  private describeChange(p: RestorePlanItem): ForkFileChange {
    const displayPath = getDisplayPath(p.filePath);
    const binary = isBinaryFile(p.filePath);
    const currentExists = existsSync(p.filePath);

    const lineCount = (content: string): number => (content === '' ? 0 : content.split('\n').length);

    // 该文件 fork 后才新建 → 回滚 = 删除
    if (!p.existedBefore) {
      let removals = 0;
      if (currentExists && !binary) {
        removals = lineCount(readTextContent(p.filePath).content);
      }
      return this.makeChange(p.filePath, displayPath, 'delete', 0, removals, binary);
    }

    const targetText = binary ? '' : this.readBlobText(p.blobHash!);

    // 旧文件被删 → 回滚 = 重新写回
    if (!currentExists) {
      const additions = binary ? 0 : lineCount(targetText);
      return this.makeChange(p.filePath, displayPath, 'recreate', additions, 0, binary);
    }

    // 覆盖回旧内容
    if (binary) {
      return this.makeChange(p.filePath, displayPath, 'modify', 0, 0, true);
    }
    const current = readTextContent(p.filePath).content;
    const { additions, removals } = countPatchLines(diffContents(p.filePath, current, targetText));
    return this.makeChange(p.filePath, displayPath, 'modify', additions, removals, false);
  }

  private makeChange(
    filePath: string,
    displayPath: string,
    effect: ForkFileEffect,
    additions: number,
    removals: number,
    binary: boolean,
  ): ForkFileChange {
    return { filePath, displayPath, effect, additions, removals, ...(binary ? { binary: true } : {}) };
  }
}

let instance: CheckpointManager | null = null;

export const getCheckpointManager = (): CheckpointManager => {
  if (!instance) {
    instance = new CheckpointManager();
  }
  return instance;
};

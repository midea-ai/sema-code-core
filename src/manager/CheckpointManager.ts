/**
 * 会话 Fork 文件级快照管理（单例）
 *
 * 职责：
 * - 维护每会话的 EditLog（文件"改动前镜像"的追加日志），通过 snapshotStore 持久化
 * - 提供 fork 预览（preview）、回滚计划（computeRestorePlan）与回滚执行（applyRestore）
 * - 原地回退时截断 EditLog（truncateEditLog）
 *
 * 设计要点见计划：每文件每 turn-segment 只捕获一次；失败关闭（fail-closed）；
 * 回滚按字节级整文件还原；不处理外部修改冲突。
 * blob/editlog 的文件 IO 与退场清理在 util/snapshotStore.ts（纯 IO，避免循环依赖）。
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { getConfManager } from './ConfManager';
import { getStateManager } from './StateManager';
import { getDisplayPath, isBinaryFile, readTextContent } from '../util/file';
import { diffContents, countPatchLines } from '../util/diff';
import {
  EditRecord,
  loadEditLog,
  saveEditLog,
  readBlob,
  writeBlob,
} from '../util/snapshotStore';
import { UserMsg } from '../types/message';
import { ForkPreview, ForkFileChange, ForkFileEffect } from '../types/fork';

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
      if (existedBefore) {
        blobHash = writeBlob(readFileSync(fullFilePath), this.projectPath());
      }

      log.push({
        seq: log.length,
        agentId,
        filePath: fullFilePath,
        blobHash,
        existedBefore,
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

  /** 选取回滚集：seq >= forkSeq 的记录中，每个文件取最早的一条 */
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
    return Array.from(byFile.values()).map(r => ({
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
        const buf = readBlob(p.blobHash!, this.projectPath());
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

  /** 释放某会话的内存 EditLog（磁盘文件保留，供重新打开/再次 fork 使用） */
  forgetSession(sessionId: string): void {
    this.editLogs.delete(sessionId);
    this.segmentStarts.delete(sessionId);
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

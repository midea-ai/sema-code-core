/**
 * Fork 快照存储层（纯文件 IO，不依赖任何 manager，避免循环依赖）
 *
 * 目录布局：
 *   ~/.sema/snapshots/<project>/
 *   ├── blobs/<sha256>            # 文件改动前的原始字节（内容寻址，跨会话去重）
 *   └── <sessionId>.editlog.json  # 每会话的 EditLog
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getProjectHistoryDir, getProjectSnapshotsDir, getSnapshotsDir } from './savePath';
import { logWarn, logDebug } from './log';

/** 一条记录 = 某文件在某 turn-segment 内的"改动前镜像" */
export interface EditRecord {
  seq: number;             // 在本会话 EditLog 中的序号 = 追加时的数组下标（单调递增）
  agentId: string;         // main 或子代理 taskId
  filePath: string;        // 绝对路径
  blobHash: string | null; // 旧内容 blob 的 sha256；existedBefore=false 时为 null
  existedBefore: boolean;  // 改动前文件是否存在
  ts: number;
}

const EDITLOG_SUFFIX = '.editlog.json';
const BLOBS_SUBDIR = 'blobs';

function snapshotsDirOf(projectPath?: string): string {
  return projectPath ? getProjectSnapshotsDir(projectPath) : getSnapshotsDir();
}

function blobsDirOf(projectPath?: string): string {
  return join(snapshotsDirOf(projectPath), BLOBS_SUBDIR);
}

function editLogPathOf(sessionId: string, projectPath?: string): string {
  return join(snapshotsDirOf(projectPath), `${sessionId}${EDITLOG_SUFFIX}`);
}

// ==================== blob 仓库（内容寻址） ====================

export function writeBlob(buf: Buffer, projectPath?: string): string {
  const hash = createHash('sha256').update(buf).digest('hex');
  const dir = blobsDirOf(projectPath);
  const path = join(dir, hash);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, buf);
  }
  return hash;
}

export function readBlob(hash: string, projectPath?: string): Buffer {
  return readFileSync(join(blobsDirOf(projectPath), hash));
}

// ==================== EditLog 持久化 ====================

export function loadEditLog(sessionId: string, projectPath?: string): EditRecord[] {
  try {
    const path = editLogPathOf(sessionId, projectPath);
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      return Array.isArray(data?.records) ? data.records : [];
    }
  } catch (error) {
    logWarn(`加载 editlog 失败 (${sessionId}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return [];
}

export function saveEditLog(sessionId: string, records: EditRecord[], projectPath?: string): void {
  const dir = snapshotsDirOf(projectPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(editLogPathOf(sessionId, projectPath), JSON.stringify({ records }, null, 2));
}

// ==================== 退场：跟随历史清理 + blob 标记清除 ====================

/**
 * 回收某项目的快照：
 * 1) 删除历史文件已不存在（被淘汰）的会话对应的 editlog
 * 2) 扫描剩余 editlog 收集仍被引用的 blob，删除无引用的 blob
 * 由 history.cleanupOldHistoryFiles 在历史清理之后调用。
 */
export function cleanupProjectSnapshots(projectPath: string): void {
  try {
    const snapDir = getProjectSnapshotsDir(projectPath);
    if (!existsSync(snapDir)) return;

    // 1) 从剩余历史文件中收集仍存活的 sessionId
    //    文件名两种格式：带日期 YYYY-MM-DD_<sessionId>.json，或无日期 <sessionId>.json（固定会话）
    const liveSessions = new Set<string>();
    const histDir = getProjectHistoryDir(projectPath);
    if (existsSync(histDir)) {
      for (const file of readdirSync(histDir)) {
        const dated = /^\d{4}-\d{2}-\d{2}_(.+)\.json$/.exec(file);
        if (dated) { liveSessions.add(dated[1]); continue; }
        if (file.endsWith('.json')) liveSessions.add(file.slice(0, -'.json'.length));
      }
    }

    // 2) 删除非存活会话的 editlog
    for (const file of readdirSync(snapDir)) {
      if (!file.endsWith(EDITLOG_SUFFIX)) continue;
      const sessionId = file.slice(0, -EDITLOG_SUFFIX.length);
      if (!liveSessions.has(sessionId)) {
        try {
          unlinkSync(join(snapDir, file));
          logDebug(`删除无主 editlog: ${file}`);
        } catch { /* 忽略 */ }
      }
    }

    // 3) blob 标记清除：收集剩余 editlog 引用的 hash，删除无引用 blob
    const referenced = new Set<string>();
    for (const file of readdirSync(snapDir)) {
      if (!file.endsWith(EDITLOG_SUFFIX)) continue;
      try {
        const data = JSON.parse(readFileSync(join(snapDir, file), 'utf8'));
        for (const r of (data?.records ?? []) as EditRecord[]) {
          if (r?.blobHash) referenced.add(r.blobHash);
        }
      } catch { /* 跳过损坏的 editlog */ }
    }

    const blobsDir = join(snapDir, BLOBS_SUBDIR);
    if (existsSync(blobsDir)) {
      let removed = 0;
      for (const hash of readdirSync(blobsDir)) {
        if (!referenced.has(hash)) {
          try { unlinkSync(join(blobsDir, hash)); removed++; } catch { /* 忽略 */ }
        }
      }
      if (removed > 0) logDebug(`回收无引用 blob ${removed} 个`);
    }
  } catch (error) {
    logWarn(`清理项目快照失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

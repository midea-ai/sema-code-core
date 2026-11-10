/**
 * Fork 快照存储层（纯文件 IO，不依赖任何 manager，避免循环依赖）
 *
 * 目录布局：
 *   ~/.sema/snapshots/<project>/
 *   ├── blobs/<sha256>            # 文件改动前的原始字节（内容寻址，跨会话去重）
 *   └── <sessionId>.editlog.json  # 每会话的 EditLog
 *
 * 加密：传了 encryption 时 editlog 与 blob 都写成 <原名>.enc（整个文件一行密文，blob 的 hash 仍按明文算），
 * 读时密文优先；清理按去掉 .enc 后的名字判断
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getProjectHistoryDir, getProjectSnapshotsDir, getSnapshotsDir } from './savePath';
import { logWarn, logDebug } from './log';
import { encName, isEncryptionEnabled, openLine, readSecureFile, stripEnc, writeSecureFile } from './cipher';
import { SemaError } from './errors';

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

/**
 * 读当前配置下读得出来的 blob：带密钥时先试密文，解不开（换密钥前写的、文件坏了）再看明文；
 * 不带密钥只看明文。都读不出来返回 null。
 * blob 跨会话复用，同一个 hash 可能是换密钥前、关加密前写的，不能只凭文件存在就当它可用
 */
function readUsableBlob(path: string): Buffer | null {
  if (isEncryptionEnabled() && existsSync(encName(path))) {
    try {
      return openLine(readFileSync(encName(path), 'utf8'));
    } catch { /* 当前密钥解不开，往下看明文 */ }
  }
  return existsSync(path) ? readFileSync(path) : null;
}

export function writeBlob(buf: Buffer, projectPath?: string): string {
  const hash = createHash('sha256').update(buf).digest('hex');
  const path = join(blobsDirOf(projectPath), hash);
  // 已有一份当前读得出来的就复用（升级前写的明文 blob 不重写）；读不出来的旧密文按当前配置重写。
  // 宿主只有一把固定密钥：换了密钥旧会话本来就打不开，旧密文被覆盖不算损失，不为多把密钥并存做隔离
  if (readUsableBlob(path) === null) {
    writeSecureFile(path, buf);
  }
  return hash;
}

export function readBlob(hash: string, projectPath?: string): Buffer {
  const path = join(blobsDirOf(projectPath), hash);
  const buf = readUsableBlob(path);
  if (buf) return buf;
  // 读不出来：密文在但没密钥 / 密钥不对时给出带错误码的原因，否则是文件不存在
  if (existsSync(encName(path))) openLine(readFileSync(encName(path), 'utf8'));
  throw new Error(`blob not found: ${hash}`);
}

// ==================== EditLog 持久化 ====================

export function loadEditLog(sessionId: string, projectPath?: string): EditRecord[] {
  try {
    const buf = readSecureFile(editLogPathOf(sessionId, projectPath));
    if (buf) {
      const data = JSON.parse(buf.toString('utf8'));
      return Array.isArray(data?.records) ? data.records : [];
    }
  } catch (error) {
    // 含密钥对不上的情况：撤销不可用，不影响会话
    logWarn(`加载 editlog 失败 (${sessionId}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return [];
}

export function saveEditLog(sessionId: string, records: EditRecord[], projectPath?: string): void {
  writeSecureFile(editLogPathOf(sessionId, projectPath), JSON.stringify({ records }, null, 2));
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
    //    文件名两种格式：带日期 YYYY-MM-DD_<sessionId>.json，或无日期 <sessionId>.json（固定会话），均可带 .enc
    const liveSessions = new Set<string>();
    const histDir = getProjectHistoryDir(projectPath);
    if (existsSync(histDir)) {
      for (const file of readdirSync(histDir)) {
        const name = stripEnc(file);
        const dated = /^\d{4}-\d{2}-\d{2}_(.+)\.json$/.exec(name);
        if (dated) { liveSessions.add(dated[1]); continue; }
        if (name.endsWith('.json')) liveSessions.add(name.slice(0, -'.json'.length));
      }
    }

    // 2) 删除非存活会话的 editlog
    const editLogFiles = readdirSync(snapDir).filter(file => stripEnc(file).endsWith(EDITLOG_SUFFIX));
    for (const file of editLogFiles) {
      const sessionId = stripEnc(file).slice(0, -EDITLOG_SUFFIX.length);
      if (!liveSessions.has(sessionId)) {
        try {
          unlinkSync(join(snapDir, file));
          logDebug(`删除无主 editlog: ${file}`);
        } catch { /* 忽略 */ }
      }
    }

    // 3) blob 标记清除：收集剩余 editlog 引用的 hash，删除无引用 blob（同一会话的明文与密文按明文名只读一次）。
    //    有 editlog 因密钥问题解不开时整步跳过：引用关系不完整，删了就找不回来
    const referenced = new Set<string>();
    const remaining = new Set(readdirSync(snapDir).filter(file => stripEnc(file).endsWith(EDITLOG_SUFFIX)).map(stripEnc));
    for (const name of remaining) {
      try {
        const buf = readSecureFile(join(snapDir, name));
        if (!buf) continue;
        const data = JSON.parse(buf.toString('utf8'));
        for (const r of (data?.records ?? []) as EditRecord[]) {
          if (r?.blobHash) referenced.add(r.blobHash);
        }
      } catch (error) {
        if (error instanceof SemaError) {
          logDebug(`editlog 解不开，跳过本轮 blob 回收: ${name}`);
          return;
        }
        /* 跳过损坏的 editlog */
      }
    }

    const blobsDir = join(snapDir, BLOBS_SUBDIR);
    if (existsSync(blobsDir)) {
      let removed = 0;
      for (const entry of readdirSync(blobsDir)) {
        if (!referenced.has(stripEnc(entry))) {
          try { unlinkSync(join(blobsDir, entry)); removed++; } catch { /* 忽略 */ }
        }
      }
      if (removed > 0) logDebug(`回收无引用 blob ${removed} 个`);
    }
  } catch (error) {
    logWarn(`清理项目快照失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

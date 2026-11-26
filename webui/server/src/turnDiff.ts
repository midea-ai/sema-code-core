/**
 * 审阅总 diff：轮级基线快照 + 编辑事件时刻重算。
 *
 * 借鉴 VS Code 插件 FileStateDiffManager 的基线思路（首次触及时捕获全文基线、新建钉空基线），
 * 但在事件到达的时刻算好总 diff 并随事件落盘：此刻磁盘内容就是该次编辑后的真实内容，
 * 之后文件再被改动，审阅里仍是当时的状态。
 *
 * 基线来源是 lastKnown（最近一次 view_file / 编辑事件后的全文）：core 强制「改前必读、
 * 读后被改过必须重读」（PatchFile/WriteFile 的 readFileTimestamps + mtime 校验），
 * 所以编辑事件到达时 lastKnown 必然就是「改前」内容，无需反向推导。
 * - 轮级总 diff（cumulative.patch）：轮开始前 → 本轮最新编辑后，供「第 N 轮」视图整体替换拼接
 * 「全部」视图的会话级基线 diff 由 core 的会话基线查询（SemaSession.getFileChanges）提供，
 * 本模块只维护轮级基线；lastKnown 缺失（服务重启 / 恢复的会话沿用 core 历史里的读时间戳，
 * 未产生新读事件）或超限时降级为现状的 patch 拼接，不会更差。
 *
 * 读盘一律走异步（本模块在事件到达的路径上调用，同步读会把主线程连同其他会话的广播一起堵住），
 * 超过 {@link BASELINE_MAX_BYTES} 的文件直接降级：不读盘也不跑 diff。
 */
import fs from 'fs';
import path from 'path';
import { structuredPatch } from 'diff';
import type { Hunk } from '../../shared/types';

/**
 * 基线内存上限：超过的文件不维护基线（降级拼接）。
 * 取 1MB：读盘与 diff 都随文件大小线性增长，4.65MB 时一次编辑阻塞主线程 50–77ms，1MB 以内可忽略；
 * 超大文件每次编辑还要留一份全文基线常驻（40–50MB）。
 */
const BASELINE_MAX_BYTES = 1024 * 1024;
/** 「全部新增」类全文落盘上限（新建文件补全与总 diff 共用） */
export const NEW_FILE_MAX_LINES = 5000;
export const NEW_FILE_MAX_BYTES = 1024 * 1024;
/** diff 类总 patch 行数上限（含上下文），防御极端场景 */
const PATCH_MAX_LINES = 20000;

interface Baseline { content: string; existed: boolean }

export interface DiffBaselines {
  /** path(绝对) -> 轮级基线；null = 该文件已降级（本轮不再算总 diff） */
  turn: Map<string, Baseline | null>;
  /** path(绝对) -> 最近一次读/编辑后的全文；编辑事件到达时即为「改前」内容 */
  lastKnown: Map<string, Baseline | null>;
}

/** 附加在编辑事件 data.cumulative 上的轮级总 diff */
export interface CumulativeDiff {
  type: 'diff' | 'new';
  patch: Hunk[];
}

export function createBaselines(): DiffBaselines { return { turn: new Map(), lastKnown: new Map() }; }
export function resetTurn(b: DiffBaselines) { b.turn.clear(); }
export function resetAll(b: DiffBaselines) { b.turn.clear(); b.lastKnown.clear(); }

function resolveAbs(workingDir: string, title: string): string {
  return path.isAbsolute(title) ? title : path.resolve(workingDir, title);
}

function normalizeLF(s: string): string { return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n'); }

/** 该文件本轮不再维护基线：轮次视图回退逐次拼接 */
function dropBaseline(b: DiffBaselines, abs: string) {
  b.turn.set(abs, null);
  b.lastKnown.set(abs, null);
}

/** 读全文（异步，超限返回 null）；读不到视为「不存在」，与旧行为一致 */
async function readFile(abs: string): Promise<Baseline | null> {
  try {
    if ((await fs.promises.stat(abs)).size > BASELINE_MAX_BYTES) return null;
    return { content: normalizeLF(await fs.promises.readFile(abs, 'utf8')), existed: true };
  } catch { return { content: '', existed: false }; }
}

/** 读文件工具完成：刷新 lastKnown（重读代表 core 认可的最新已知内容，直接覆盖） */
export async function captureOnRead(b: DiffBaselines, workingDir: string, title: string): Promise<void> {
  const abs = resolveAbs(workingDir, title);
  b.lastKnown.set(abs, await readFile(abs));
}

/** 基线 → 当前内容的总 diff；超限返回 undefined（降级） */
function totalPatch(base: Baseline, current: string): Hunk[] | undefined {
  if (!base.existed) {
    const lines = current.split('\n');
    if (lines.length > NEW_FILE_MAX_LINES || Buffer.byteLength(current, 'utf8') > NEW_FILE_MAX_BYTES) return undefined;
    return [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map(l => '+' + l) }];
  }
  const hunks = structuredPatch('a', 'b', base.content, current, '', '', { context: 3 }).hunks as Hunk[];
  const total = hunks.reduce((s, h) => s + (h.lines?.length || 0), 0);
  if (total > PATCH_MAX_LINES) return undefined;
  return hunks;
}

/** 编辑完成事件：确定/更新基线并重算总 diff；返回 undefined = 降级为拼接 */
export async function computeCumulative(b: DiffBaselines, workingDir: string, title: string, content: any): Promise<CumulativeDiff | undefined> {
  const abs = resolveAbs(workingDir, title);
  let current: string;
  try {
    if ((await fs.promises.stat(abs)).size > BASELINE_MAX_BYTES) { dropBaseline(b, abs); return; }
    current = normalizeLF(await fs.promises.readFile(abs, 'utf8'));
  } catch { dropBaseline(b, abs); return; }

  const isNew = content?.type === 'new';
  // 首次触及：新建钉空基线；否则用 lastKnown（core 保证是改前内容）；缺失/超限即降级
  if (!b.turn.has(abs)) b.turn.set(abs, isNew ? { content: '', existed: false } : (b.lastKnown.get(abs) ?? null));
  const turnBase = b.turn.get(abs) ?? null;
  b.lastKnown.set(abs, { content: current, existed: true });
  if (!turnBase) return;

  const patch = totalPatch(turnBase, current);
  if (!patch) { b.turn.set(abs, null); return; }
  return { type: turnBase.existed ? 'diff' : 'new', patch };
}

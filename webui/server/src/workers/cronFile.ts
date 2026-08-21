/**
 * 主进程侧直接读取项目的持久化定时任务文件（.sema/scheduled_tasks.json），
 * 不依赖 worker 存活：供 cron keeper 判断"临近触发、需要拉起 worker"以及退场判定。
 * 触发时间计算复用 sema-core 依赖里的 cron-parser（沿 sema-core 解析，server 不单独声明依赖）。
 */
import fs from 'fs';
import path from 'path';
import type { CronTask } from '../../../shared/types';

const TASKS_FILE = path.join('.sema', 'scheduled_tasks.json');
const SETTINGS_FILE = path.join('.sema', 'settings.json');

let parser: any | null | undefined;
function cronParser(): any | null {
  if (parser !== undefined) return parser;
  try {
    const coreMain = require.resolve('sema-core');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    parser = require(require.resolve('cron-parser', { paths: [path.dirname(coreMain)] }));
  } catch {
    try { parser = require('cron-parser'); } catch { parser = null; }
  }
  return parser;
}

/** 从 fromMs 起的下一次触发时间（ms）；表达式非法或无解析器时返回 null */
export function nextFireAt0(expr: string, fromMs: number): number | null {
  const p = cronParser();
  if (!p) return null;
  try {
    const Parser = p.CronExpressionParser || p;
    const it = Parser.parse(expr, { currentDate: new Date(fromMs) });
    return it.next().getTime();
  } catch { return null; }
}

/** 与 core describeCronExpression 同样的简版人话描述（英文，与 worker 返回的保持一致） */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute, hour, dom, month, dow] = parts;
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') return 'every minute';
  if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
    if (minute.startsWith('*/')) return `every ${minute.slice(2)} minutes`;
    return `at minute ${minute} of every hour`;
  }
  if (dom === '*' && month === '*' && dow === '*') {
    if (hour.startsWith('*/')) return `every ${hour.slice(2)} hours at minute ${minute}`;
    return `daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  if (dom === '*' && month === '*' && dow !== '*') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayStr = dow.split(',').map(d => dayNames[parseInt(d)] || d).join(', ');
    return `${dayStr} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  return expr;
}

/** 从 fromMs 起接下来 count 次触发时间 */
export function nextFireAts(expr: string, fromMs: number, count: number): number[] {
  const p = cronParser();
  if (!p) return [];
  try {
    const Parser = p.CronExpressionParser || p;
    const it = Parser.parse(expr, { currentDate: new Date(fromMs) });
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(it.next().getTime());
    return out;
  } catch { return []; }
}

/**
 * 读取目录下持久化定时任务明细（worker 未拉起时日程页用），形状与 core CronTask 一致：
 * persist=true；status 按 disabledCronTasks；过期的一次性任务按 core 规则剔除。
 */
export function readPersistedTasks(workingDir: string, now = Date.now()): CronTask[] {
  const data = readJson(path.join(workingDir, TASKS_FILE));
  const tasks: any[] = Array.isArray(data?.tasks) ? data.tasks : [];
  if (!tasks.length) return [];
  const disabled = new Set<string>(readJson(path.join(workingDir, SETTINGS_FILE))?.disabledCronTasks ?? []);
  const filePath = path.join(workingDir, TASKS_FILE);
  const out: CronTask[] = [];
  for (const t of tasks) {
    if (!t?.id || !t.schedule) continue;
    let nextFireAt: number[];
    if (t.repeat) {
      nextFireAt = nextFireAts(t.schedule, now, 4);
    } else {
      if (t.lastFiredAt != null) continue;
      const first = nextFireAt0(t.schedule, Number(t.createdAt) || now);
      if (first == null || first <= now) continue;
      nextFireAt = [first];
    }
    if (!nextFireAt.length) continue;
    out.push({
      id: String(t.id), schedule: String(t.schedule), task: String(t.task ?? ''), title: t.title ? String(t.title) : undefined,
      repeat: !!t.repeat, persist: true, status: !disabled.has(t.id), filePath, createdAt: Number(t.createdAt) || now,
      describeCronExpression: describeCron(String(t.schedule)), activatedAt: now, lastFiredAt: t.lastFiredAt ?? undefined, nextFireAt,
    });
  }
  return out;
}

export interface PersistedCronSummary {
  /** 启用且未过期的持久化任务数 */
  active: number;
  /** 最近一次触发时间（ms），无则 null */
  nextFireAt: number | null;
}

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 汇总某目录下持久化定时任务（与 core CronManager.loadFromFile 的过期/禁用规则保持一致） */
export function readPersistedCron(workingDir: string, now = Date.now()): PersistedCronSummary {
  const out: PersistedCronSummary = { active: 0, nextFireAt: null };
  const data = readJson(path.join(workingDir, TASKS_FILE));
  const tasks: any[] = Array.isArray(data?.tasks) ? data.tasks : [];
  if (!tasks.length) return out;
  const disabled = new Set<string>(readJson(path.join(workingDir, SETTINGS_FILE))?.disabledCronTasks ?? []);
  for (const t of tasks) {
    if (!t?.id || !t.schedule || disabled.has(t.id)) continue;
    let next: number | null;
    if (t.repeat) {
      next = nextFireAt0(t.schedule, now);
    } else {
      // 一次性任务：原定首次触发（从创建时间起算）已过或已触发 → core 加载时会丢弃
      if (t.lastFiredAt != null) continue;
      next = nextFireAt0(t.schedule, Number(t.createdAt) || now);
      if (next != null && next <= now) continue;
    }
    if (next == null) continue;
    out.active++;
    if (out.nextFireAt == null || next < out.nextFireAt) out.nextFireAt = next;
  }
  return out;
}

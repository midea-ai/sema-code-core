import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import type { UsageStatsData, UsageTokens } from '../../../../shared/types';
import { useApp } from '../../store/app';
import { api } from '../../api/http';
import { cn, Spinner, useDialog } from '../../common/ui';
import { t, dateLocale, useLang, type I18nKey } from '../../i18n';
import { collapsedHeaderPad } from '../../common/desktop';
import {
  dateKeyOf, formatCount, formatDateFull, formatDateShort, formatMonth, formatPercent,
  formatUpdatedAt, formatUsageTokens, formatWeekday, fromDateKey, toDateKey,
} from './usageFormat';

/**
 * 「使用情况」页：披露本应用的 token、模型、工具、skill 使用计数。
 * 数据由 core 采集落盘，进入页面拉一次逐日聚合（GET /api/usage，按产品 sema-webui 过滤），7 / 30 / 365 天的求和在这里做；
 * 停留期间不刷新，切换范围不重新取数。清除走二次确认（POST /api/usage/clear）。
 */

type UsageRange = '7d' | '30d' | '1y';

/** 某时间范围内的汇总（由 days 求得） */
interface UsageRangeSummary {
  dates: string[];   // 范围内全部日期（含未记录），升序
  requests: number;
  tokens: UsageTokens;
  sessions: number;
  models: Array<{ name: string; requests: number; hitKnown: boolean; tokens: UsageTokens; total: number }>;
  tools: Array<{ name: string; calls: number; errors: number }>;
  skills: Array<{ name: string; calls: number; lastAt: number }>;
}

const RANGE_DAYS: Record<UsageRange, number> = { '7d': 7, '30d': 30, '1y': 365 };
const RANGES: UsageRange[] = ['7d', '30d', '1y'];
const TOP_N = 5;
/** 模型长条：低于范围内最大用量的 5% 不画长条，只留名称与数值 */
const MIN_BAR_RATIO = 0.05;
/** 30 天柱状图的 x 轴刻度下标间隔 */
const BAR_LABEL_EVERY = 10;

/** 有用途文案的内置工具（key 为 usage.tool.<name>） */
const KNOWN_TOOLS = new Set([
  'view_file', 'write_file', 'patch_file', 'run_shell', 'search_files', 'search_content', 'fetch_url',
  'sub_agent', 'skill', 'edit_notebook', 'ask_form', 'plan_to_agent', 'load_tools',
  'create_todo', 'update_todo', 'get_todo', 'list_todos', 'create_cron', 'del_cron', 'list_crons',
  'peek_bg_job', 'stop_bg_job',
]);

const emptyTokens = (): UsageTokens => ({ hit: 0, miss: 0, output: 0 });
const tokenTotal = (x: UsageTokens) => x.hit + x.miss + x.output;
const addTokens = (a: UsageTokens, b: UsageTokens) => { a.hit += b.hit; a.miss += b.miss; a.output += b.output; };

/** 截至 today 的 n 个日期键，升序 */
function datesBack(todayKey: string, n: number): string[] {
  const today = fromDateKey(todayKey);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    out.push(toDateKey(d));
  }
  return out;
}

function summarize(data: UsageStatsData, dates: string[]): UsageRangeSummary {
  const tokens = emptyTokens();
  let requests = 0;
  const sessions = new Set<string>();
  const models = new Map<string, { requests: number; hitKnown: boolean; tokens: UsageTokens }>();
  const tools = new Map<string, { calls: number; errors: number }>();
  const skills = new Map<string, { calls: number; lastAt: number }>();
  for (const key of dates) {
    const day = data.days[key];
    if (!day) continue;
    requests += day.requests;
    addTokens(tokens, day.tokens);
    for (const s of day.sessions) sessions.add(s);
    for (const [name, m] of Object.entries(day.models)) {
      const cur = models.get(name) ?? { requests: 0, hitKnown: false, tokens: emptyTokens() };
      cur.requests += m.requests;
      cur.hitKnown = cur.hitKnown || m.hitKnown;
      addTokens(cur.tokens, m.tokens);
      models.set(name, cur);
    }
    for (const [name, s] of Object.entries(day.tools)) {
      const cur = tools.get(name) ?? { calls: 0, errors: 0 };
      cur.calls += s.calls;
      cur.errors += s.errors;
      tools.set(name, cur);
    }
    for (const [name, s] of Object.entries(day.skills)) {
      const cur = skills.get(name) ?? { calls: 0, lastAt: 0 };
      cur.calls += s.calls;
      cur.lastAt = Math.max(cur.lastAt, s.lastAt);
      skills.set(name, cur);
    }
  }
  return {
    dates,
    requests,
    tokens,
    sessions: sessions.size,
    models: [...models.entries()].map(([name, m]) => ({ name, ...m, total: tokenTotal(m.tokens) })).sort((a, b) => b.total - a.total),
    tools: [...tools.entries()].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.calls - a.calls),
    skills: [...skills.entries()].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.calls - a.calls),
  };
}

/** y 轴上限：把 max/4 取整到 1 / 2 / 5 × 10^k，共四格 */
function niceAxis(max: number): { step: number; top: number } {
  if (max <= 0) return { step: 1, top: 4 };
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { step, top: step * 4 };
}

/** 热力图固定分档：< 100K / 100K–1M / 1M–10M / ≥ 10M；无用量与未记录同样式，不单独分档 */
function heatLevel(value: number): number {
  if (value < 100_000) return 1;
  if (value < 1_000_000) return 2;
  if (value < 10_000_000) return 3;
  return 4;
}

/** 工具显示名：内置工具给用途 + 弱化原始名；MCP 工具给 服务 · 工具，完整名放悬浮；其余原样 */
function toolLabel(name: string): { primary: string; secondary?: string; title?: string } {
  if (name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const idx = rest.indexOf('__');
    if (idx > 0) return { primary: `${rest.slice(0, idx)} · ${rest.slice(idx + 2)}`, title: name };
    return { primary: name };
  }
  if (KNOWN_TOOLS.has(name)) return { primary: t(`usage.tool.${name}` as I18nKey), secondary: name };
  return { primary: name };
}

interface HoverTip { x: number; y: number; node: React.ReactNode }

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn('h-6 px-2.5 rounded-full text-xs border', active ? 'bg-primary text-white border-transparent' : 'text-fg border-border hover:bg-black/[0.05]')}>
      {children}
    </button>
  );
}

function LinkBtn({ onClick, disabled, className, children }: { onClick: () => void; disabled?: boolean; className?: string; children: React.ReactNode }) {
  return <button onClick={onClick} disabled={disabled} className={cn('text-xs text-accent hover:underline', className)}>{children}</button>;
}

export function UsagePage() {
  // 订阅界面语言：切换时重渲染（数据与状态保留）
  useLang();
  const locale = dateLocale();
  const sidebarCollapsed = useApp(s => s.sidebarCollapsed);
  const toast = useApp(s => s.toast);
  const dialog = useDialog();

  const [data, setData] = useState<UsageStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<UsageRange>('30d');
  const [capTab, setCapTab] = useState<'tools' | 'skills'>('tools');
  const [showAllTools, setShowAllTools] = useState(false);
  const [showAllSkills, setShowAllSkills] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [mcpOnly, setMcpOnly] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [tip, setTip] = useState<HoverTip | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // 数据截止时间以本次进入页面为准；切换范围不改变
  const [todayKey, setTodayKey] = useState(() => toDateKey(new Date()));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setTodayKey(toDateKey(new Date()));
    try {
      setData(await api<UsageStatsData>('GET', '/api/usage'));
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const clear = async () => {
    const ok = await dialog.confirm({ title: t('usage.clearTitle'), message: t('usage.clearConfirm'), danger: true, okText: t('usage.clearOk') });
    if (!ok) return;
    setClearing(true);
    try {
      await api('POST', '/api/usage/clear');
      // 清除成功后回到无记录状态并重新计算开始记录日期
      await load();
    } catch (e: any) {
      toast(`${t('usage.clearFailed')}：${e?.message || e}`, 'error');
    } finally {
      setClearing(false);
    }
  };

  const summary = useMemo(() => data ? summarize(data, datesBack(todayKey, RANGE_DAYS[range])) : null, [data, range, todayKey]);
  const rangeHasData = useMemo(() => !!data && !!summary && summary.dates.some(d => !!data.days[d]), [data, summary]);

  // ─── 悬浮提示（柱、热力格、模型长条共用，坐标相对页面容器）───
  const showTip = (e: React.MouseEvent, node: React.ReactNode) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top, node });
  };
  const hideTip = () => setTip(null);
  const tipEvents = (node: () => React.ReactNode) => ({
    onMouseEnter: (e: React.MouseEvent) => showTip(e, node()),
    onMouseMove: (e: React.MouseEvent) => showTip(e, node()),
    onMouseLeave: hideTip,
  });

  const dayTip = (key: string): React.ReactNode => {
    const day = data?.days[key];
    return (
      <>
        <div className="usage-tip-title">{formatDateFull(key)} · {formatWeekday(key, locale)}</div>
        {day ? (
          <>
            <div className="usage-tip-row"><span>{t('usage.card.tokens')}</span><span>{formatUsageTokens(tokenTotal(day.tokens))}</span></div>
            <div className="usage-tip-row"><span>{t('usage.card.requests')}</span><span>{t('usage.times', { n: formatCount(day.requests) })}</span></div>
            <div className="usage-tip-row"><span>{t('usage.card.sessions')}</span><span>{t('usage.sessionsUnit', { n: formatCount(day.sessions.length) })}</span></div>
          </>
        ) : (
          <div className="text-muted">{t('usage.unrecorded')}</div>
        )}
      </>
    );
  };

  // ─── 各区块 ───

  const renderBars = () => {
    if (!data || !summary) return null;
    const values = summary.dates.map(d => data.days[d] ? tokenTotal(data.days[d].tokens) : null);
    const max = Math.max(0, ...values.map(v => v ?? 0));
    const axis = niceAxis(max);
    const ticks = [4, 3, 2, 1, 0].map(i => axis.step * i);
    const n = summary.dates.length;
    const labelIdx = new Set<number>(n <= 7 ? summary.dates.map((_, i) => i) : [0, ...summary.dates.map((_, i) => i).filter(i => i > 0 && i % BAR_LABEL_EVERY === 0 && n - 1 - i >= 4), n - 1]);
    return (
      <div className="usage-bars">
        <div className="usage-bars-axis">
          {ticks.map(v => <span key={v}>{formatUsageTokens(v)}</span>)}
        </div>
        <div className="usage-bars-plot">
          <div className="usage-bars-grid">
            {ticks.map(v => <div key={v} className="usage-bars-gridline" />)}
          </div>
          <div className="usage-bars-cols">
            {summary.dates.map((key, i) => {
              const v = values[i];
              const pct = v === null ? 0 : Math.max(v > 0 ? 1 : 0, (v / axis.top) * 100);
              return (
                <div key={key} className="usage-bar-col" {...tipEvents(() => dayTip(key))}>
                  {v !== null && <div className={cn('usage-bar', v === 0 && 'zero')} style={{ height: `${pct}%` }} />}
                </div>
              );
            })}
          </div>
          <div className="usage-bars-labels">
            {summary.dates.map((key, i) => (
              <div key={key} className="usage-bar-label">
                {labelIdx.has(i) ? <span>{formatDateShort(key, todayKey)}</span> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderHeatmap = () => {
    if (!data || !summary) return null;
    const first = fromDateKey(summary.dates[0]);
    // 列为周，行为周日到周六；首列从范围首日所在周的周日开始，尾列补到周六
    const startOffset = first.getDay();
    const gridStart = new Date(first);
    gridStart.setDate(first.getDate() - startOffset);
    const totalDays = startOffset + summary.dates.length;
    const weeks = Math.ceil(totalDays / 7);
    const inRange = new Set(summary.dates);

    const columns: { key: string; date: Date }[][] = [];
    for (let w = 0; w < weeks; w++) {
      const col: { key: string; date: Date }[] = [];
      for (let r = 0; r < 7; r++) {
        const d = new Date(gridStart);
        d.setDate(gridStart.getDate() + w * 7 + r);
        col.push({ key: toDateKey(d), date: d });
      }
      columns.push(col);
    }
    // 月份标签：月份切换的列标出；开头的残月不标（除非范围恰好从 1 号开始）；相邻太近则跳过
    const monthLabels: { col: number; text: string }[] = [];
    let prevMonth = first.getDate() === 1 ? -1 : first.getMonth();
    let lastLabelCol = -10;
    columns.forEach((col, i) => {
      const firstIn = col.find(c => inRange.has(c.key));
      if (!firstIn) return;
      const m = firstIn.date.getMonth();
      if (m !== prevMonth) {
        if (i - lastLabelCol >= 3) {
          monthLabels.push({ col: i, text: formatMonth(firstIn.date, locale) });
          lastLabelCol = i;
        }
        prevMonth = m;
      }
    });
    return (
      <div className="usage-heat-wrap">
        <div className="usage-heat" style={{ gridTemplateColumns: `repeat(${weeks}, var(--usage-cell))` }}>
          {columns.map((_, i) => {
            const label = monthLabels.find(m => m.col === i);
            return <div key={i} className="usage-heat-month">{label ? label.text : ''}</div>;
          })}
          {[0, 1, 2, 3, 4, 5, 6].map(r => (
            <React.Fragment key={r}>
              {columns.map((col, i) => {
                const cell = col[r];
                if (!inRange.has(cell.key)) return <div key={i} className="usage-cell outside" />;
                const total = data.days[cell.key] ? tokenTotal(data.days[cell.key].tokens) : 0;
                const cls = total > 0 ? `l${heatLevel(total)}` : 'unrecorded';
                return <div key={i} className={`usage-cell ${cls}`} {...tipEvents(() => dayTip(cell.key))} />;
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  };

  const renderTools = () => {
    if (!summary) return null;
    if (!summary.tools.length) return <div className="py-4 text-[13px] text-muted">{t('usage.emptyTools')}</div>;
    // 「只看 MCP 工具」：范围内有 MCP 工具才提供，开启后汇总、列表、异常都只算 MCP 工具
    const hasMcp = summary.tools.some(x => x.name.startsWith('mcp__'));
    const tools = mcpOnly && hasMcp ? summary.tools.filter(x => x.name.startsWith('mcp__')) : summary.tools;
    const totalCalls = tools.reduce((s, x) => s + x.calls, 0);
    const totalErrors = tools.reduce((s, x) => s + x.errors, 0);
    const max = tools[0].calls;
    const visible = showAllTools ? tools : tools.slice(0, TOP_N);
    const failed = tools.filter(x => x.errors > 0).sort((a, b) => b.errors - a.errors);
    return (
      <>
        <div className="flex items-center justify-between flex-wrap gap-2 text-xs text-muted">
          <span>{t('usage.toolsSummary', { kinds: tools.length, calls: formatCount(totalCalls) })}</span>
          {hasMcp && (
            <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" className="m-0 w-[13px] h-[13px] cursor-pointer" checked={mcpOnly} onChange={e => setMcpOnly(e.target.checked)} />
              {t('usage.mcpOnly')}
            </label>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          {visible.map(x => {
            const label = toolLabel(x.name);
            return (
              <div className="usage-row" key={x.name}>
                <div className="usage-row-name" title={label.title ?? x.name}>
                  <span>{label.primary}</span>
                  {label.secondary && <span className="shrink-0 text-xs text-muted">{label.secondary}</span>}
                </div>
                <div className="usage-row-bar"><div className="usage-row-fill" style={{ width: `${(x.calls / max) * 100}%` }} /></div>
                <div className="shrink-0 min-w-16 text-right text-[13px] tabular-nums">{t('usage.times', { n: formatCount(x.calls) })}</div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          {tools.length > TOP_N && (
            <LinkBtn onClick={() => setShowAllTools(v => !v)}>
              {showAllTools ? t('usage.showLess') : t('usage.showAll', { n: tools.length })}
            </LinkBtn>
          )}
          <span className="flex-1" />
          {totalErrors > 0 && (
            <LinkBtn className="text-muted hover:text-fg" onClick={() => setShowErrors(v => !v)}>
              <span className={cn('inline-block mr-1 transition-transform', showErrors && 'rotate-90')}>▸</span>{t('usage.errorsEntry', { n: formatCount(totalErrors) })}
            </LinkBtn>
          )}
        </div>
        {totalErrors > 0 && showErrors && (
          <div className="px-3 py-2.5 bg-panel-2 border border-border rounded-lg">
            <table className="usage-table">
              <thead>
                <tr><th>{t('usage.col.tool')}</th><th className="num">{t('usage.col.errors')}</th><th className="num">{t('usage.col.errorRate')}</th></tr>
              </thead>
              <tbody>
                {failed.map(x => (
                  <tr key={x.name}>
                    <td title={x.name}>{toolLabel(x.name).primary}</td>
                    <td className="num">{t('usage.times', { n: formatCount(x.errors) })}</td>
                    <td className="num">{formatPercent(x.errors / x.calls)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 text-xs text-muted">{t('usage.errorsNote')}</div>
          </div>
        )}
      </>
    );
  };

  const renderSkills = () => {
    if (!summary) return null;
    const skills = summary.skills;
    if (!skills.length) return <div className="py-4 text-[13px] text-muted">{t('usage.emptySkills')}</div>;
    const totalCalls = skills.reduce((s, x) => s + x.calls, 0);
    const visible = showAllSkills ? skills : skills.slice(0, TOP_N);
    return (
      <>
        <div className="text-xs text-muted">{t('usage.skillsSummary', { kinds: skills.length, calls: formatCount(totalCalls) })}</div>
        <table className="usage-table">
          <thead>
            <tr><th>{t('usage.col.skill')}</th><th className="num">{t('usage.col.calls')} ↓</th><th className="num">{t('usage.col.lastUsed')}</th></tr>
          </thead>
          <tbody>
            {visible.map(x => (
              <tr key={x.name}>
                <td title={x.name}>{x.name}</td>
                <td className="num">{t('usage.times', { n: formatCount(x.calls) })}</td>
                <td className="num">{formatDateShort(dateKeyOf(x.lastAt), todayKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {skills.length > TOP_N && (
          <div className="mt-0.5">
            <LinkBtn onClick={() => setShowAllSkills(v => !v)}>
              {showAllSkills ? t('usage.showLess') : t('usage.showAll', { n: skills.length })}
            </LinkBtn>
          </div>
        )}
      </>
    );
  };

  const renderModels = () => {
    if (!summary) return null;
    const models = summary.models;
    if (!models.length) return <div className="py-4 text-[13px] text-muted">{t('usage.emptyModels')}</div>;
    const grand = models.reduce((s, m) => s + m.total, 0);
    const max = models[0].total;
    const visible = showAllModels ? models : models.slice(0, TOP_N);
    const modelTip =(m: typeof models[number]): React.ReactNode => {
      const input = m.tokens.hit + m.tokens.miss;
      const hitRate = !m.hitKnown ? t('usage.hitRateUnknown') : input === 0 ? '—' : formatPercent(m.tokens.hit / input);
      return (
        <>
          <div className="usage-tip-title">{m.name}</div>
          <div className="usage-tip-row"><span>{t('usage.card.tokens')}</span><span>{formatUsageTokens(m.total)}</span></div>
          <div className="usage-tip-row"><span>{t('usage.share')}</span><span>{grand ? formatPercent(m.total / grand) : '—'}</span></div>
          <div className="usage-tip-sep" />
          <div className="usage-tip-row"><span><i className="usage-swatch hit" />{t('usage.hit')}</span><span>{formatUsageTokens(m.tokens.hit)}</span></div>
          <div className="usage-tip-row"><span><i className="usage-swatch miss" />{t('usage.miss')}</span><span>{formatUsageTokens(m.tokens.miss)}</span></div>
          <div className="usage-tip-row"><span><i className="usage-swatch output" />{t('usage.output')}</span><span>{formatUsageTokens(m.tokens.output)}</span></div>
          <div className="usage-tip-sep" />
          <div className="usage-tip-row"><span>{t('usage.hitRate')}</span><span>{hitRate}</span></div>
        </>
      );
    };
    return (
      <>
        <div className="flex flex-wrap gap-4 text-xs text-muted">
          <span><i className="usage-swatch hit" />{t('usage.hit')}</span>
          <span><i className="usage-swatch miss" />{t('usage.miss')}</span>
          <span><i className="usage-swatch output" />{t('usage.output')}</span>
        </div>
        <div className="flex justify-between text-xs text-muted pb-1 border-b border-border">
          <span>{t('usage.col.model')}</span>
          <span>{t('usage.col.composition')} ↓</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {visible.map(m => {
            const drawBar = max > 0 && m.total / max >= MIN_BAR_RATIO;
            const width = max > 0 ? (m.total / max) * 100 : 0;
            const seg = (v: number) => m.total > 0 ? `${(v / m.total) * 100}%` : '0%';
            return (
              <div className="usage-row usage-model-row" key={m.name}>
                <div className="usage-row-name" title={m.name} {...tipEvents(() => modelTip(m))}>
                  <span>{m.name}</span>
                </div>
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  {drawBar && (
                    <div className="usage-model-bar" style={{ width: `${width}%` }} {...tipEvents(() => modelTip(m))}>
                      <i className="usage-seg hit" style={{ width: seg(m.tokens.hit) }} />
                      <i className="usage-seg miss" style={{ width: seg(m.tokens.miss) }} />
                      <i className="usage-seg output" style={{ width: seg(m.tokens.output) }} />
                    </div>
                  )}
                  <span className="shrink-0 text-[13px] tabular-nums cursor-default" {...tipEvents(() => modelTip(m))}>
                    {formatUsageTokens(m.total)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        {models.length > TOP_N && (
          <div className="mt-0.5">
            <LinkBtn onClick={() => setShowAllModels(v => !v)}>
              {showAllModels ? t('usage.showLess') : t('usage.showAll', { n: models.length })}
            </LinkBtn>
          </div>
        )}
      </>
    );
  };

  // ─── 页面 ───

  const renderBody = () => {
    if (loading && !data) {
      return <div className="flex items-center justify-center py-16 gap-2 text-muted text-sm"><Spinner /> {t('common.loading')}</div>;
    }
    if (error && !data) {
      return (
        <div className="flex items-center justify-center py-16 gap-2 text-muted text-sm">
          <span>{t('usage.loadFailed')}</span>
          <LinkBtn onClick={() => void load()}>{t('usage.retry')}</LinkBtn>
        </div>
      );
    }
    if (!data || !summary) return null;

    const rangeLabel = `${formatDateFull(summary.dates[0])}–${formatDateFull(summary.dates[summary.dates.length - 1])}`;
    const tipStyle: React.CSSProperties | undefined = tip
      ? (pageRef.current && tip.x > pageRef.current.clientWidth / 2
        ? { left: tip.x - 12, top: tip.y + 14, transform: 'translateX(-100%)' }
        : { left: tip.x + 12, top: tip.y + 14 })
      : undefined;

    return (
      <div className="usage-page flex flex-col gap-6" ref={pageRef}>
        {data.since ? (
          <div className="flex items-center gap-1.5 text-[13px] text-muted">
            <span>{t('usage.summary', { tokens: formatUsageTokens(tokenTotal(data.totals.tokens)), sessions: formatCount(data.totals.sessions), days: formatCount(data.totals.days) })}</span>
            <span className="usage-info" tabIndex={0} aria-label={t('usage.info', { date: formatDateFull(data.since) })}>
              <Info size={14} />
              <span className="usage-info-bubble" role="tooltip">{t('usage.info', { date: formatDateFull(data.since) })}</span>
            </span>
          </div>
        ) : (
          <div className="py-10 text-center text-sm text-muted">{t('usage.emptyAll')}</div>
        )}

        {data.since && (
          <>
            <section className="flex flex-col gap-3 pt-5 border-t border-border">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="inline-flex gap-1">
                  {RANGES.map(r => <Pill key={r} active={range === r} onClick={() => setRange(r)}>{t(`usage.range.${r}` as I18nKey)}</Pill>)}
                </div>
                <span className="text-xs text-muted tabular-nums">{rangeLabel}</span>
              </div>
              <div className="flex flex-wrap gap-3">
                {([
                  ['usage.card.tokens', formatUsageTokens(tokenTotal(summary.tokens))],
                  ['usage.card.requests', t('usage.times', { n: formatCount(summary.requests) })],
                  ['usage.card.sessions', t('usage.sessionsUnit', { n: formatCount(summary.sessions) })],
                ] as Array<[I18nKey, string]>).map(([k, v]) => (
                  <div key={k} className="flex-1 basis-[140px] min-w-[140px] px-3.5 py-3 bg-white border border-border rounded-lg">
                    <div className="text-xs text-muted mb-1">{t(k)}</div>
                    <div className="text-xl font-semibold tabular-nums">{v}</div>
                  </div>
                ))}
              </div>
              <div className="text-sm font-semibold mt-2">{t('usage.trend')}</div>
              {!rangeHasData ? <div className="py-4 text-[13px] text-muted">{t('usage.emptyRange')}</div> : range === '1y' ? renderHeatmap() : renderBars()}
            </section>

            <section className="flex flex-col gap-3 pt-5 border-t border-border">
              <div className="text-sm font-semibold">{t('usage.models')}</div>
              {renderModels()}
            </section>

            <section className="flex flex-col gap-3 pt-5 border-t border-border">
              <div className="text-sm font-semibold">{t('usage.capability')}</div>
              <div className="inline-flex gap-1 mb-0.5">
                <Pill active={capTab === 'tools'} onClick={() => setCapTab('tools')}>{t('usage.tab.tools')}</Pill>
                <Pill active={capTab === 'skills'} onClick={() => setCapTab('skills')}>{t('usage.tab.skills')}</Pill>
              </div>
              {capTab === 'tools' ? renderTools() : renderSkills()}
            </section>
          </>
        )}

        <div className="flex items-center justify-between flex-wrap gap-2 pt-5 border-t border-border text-xs text-muted">
          <span>
            {t('usage.localOnly')}
            {' · '}
            {error ? t('usage.loadFailed') : t('usage.updatedAt', { time: formatUpdatedAt(data.updatedAt, new Date()) })}
            {error && <>{' '}<LinkBtn onClick={() => void load()}>{t('usage.retry')}</LinkBtn></>}
          </span>
          {data.since && (
            <LinkBtn className="text-muted hover:text-danger hover:no-underline" disabled={clearing} onClick={() => void clear()}>
              {t('usage.clear')}
            </LinkBtn>
          )}
        </div>

        {tip && <div className="usage-tip" style={tipStyle}>{tip.node}</div>}
      </div>
    );
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className={cn('app-drag h-11 shrink-0 flex items-center gap-2 px-4 border-b border-border', sidebarCollapsed && collapsedHeaderPad)}>
        <span className="text-sm font-medium">{t('usage.title')}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6">
          {renderBody()}
        </div>
      </div>
    </div>
  );
}

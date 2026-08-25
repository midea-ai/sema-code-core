import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Folder, ArrowUpRight } from 'lucide-react';
import type { CronGroup } from '../../../../shared/types';
import { useApp } from '../../store/app';
import { api } from '../../api/http';
import { cn, Spinner, Button } from '../../common/ui';
import { t } from '../../i18n';
import { CronTaskCard, parseCronFileRef } from '../panel/CronTaskCard';
import { shortPath } from '../../common/text';
import { sortCronTasks } from '../panel/CronTab';

/** 时间线事件：启用中任务的一次未来触发 */
interface CronEvent { ts: number; taskId: string; name: string; projectName: string }

function buildEvents(groups: CronGroup[], now: number): CronEvent[] {
  const events: CronEvent[] = [];
  for (const g of groups) {
    for (const task of g.tasks) {
      if (!task.status) continue;
      for (const ts of task.nextFireAt) {
        if (ts > now) events.push({ ts, taskId: task.id, name: task.title || task.id, projectName: g.projectName });
      }
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts: number, now: number): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return t('schedule.today');
  if (key === dayKey(now + 86400000)) return t('schedule.tomorrow');
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 日程页：左侧按触发时间平铺全部事件，右侧按项目分组展示定时任务（worker 是否存活对用户透明，由 keeper 保证到点拉起） */
export function SchedulePage() {
  const cronUpdates = useApp(s => s.cronUpdates);
  const registry = useApp(s => s.registry);
  const toast = useApp(s => s.toast);
  const setView = useApp(s => s.setView);
  const openFileTab = useApp(s => s.openFileTab);
  const sidebarCollapsed = useApp(s => s.sidebarCollapsed);
  const [groups, setGroups] = useState<CronGroup[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 窄容器（<48rem）降级为单栏，由该 tab 切换时间线/任务；宽容器下 CSS 强制双栏同显，此状态无效
  const [tab, setTab] = useState<'timeline' | 'tasks'>('tasks');
  const [tick, setTick] = useState(0);
  const rightRef = useRef<HTMLDivElement>(null);

  const load = async (silent = false) => {
    try { setGroups(await api<CronGroup[]>('GET', '/api/cron')); }
    catch (e: any) { if (!silent) toast(`${t('cron.loadFailed')}：${e?.message || e}`, 'error'); }
  };
  // 首次 + 任一目录 cron:update + 注册表变化时重拉
  const version = useMemo(() => Object.values(cronUpdates).reduce((a, b) => a + b, 0), [cronUpdates]);
  useEffect(() => { void load(groups !== null); }, [version, registry.projects.length, registry.sessions.length]);
  // 每分钟重算一次时间线，让已过期的事件自然消失
  useEffect(() => { const h = setInterval(() => setTick(v => v + 1), 60000); return () => clearInterval(h); }, []);

  const now = Date.now();
  const events = useMemo(() => buildEvents(groups || [], now), [groups, tick]);

  const act = async (workingDir: string, action: 'delete' | 'enable' | 'disable', id: string) => {
    // 启停乐观更新；删除等 cron:update 刷新
    if (action !== 'delete') setGroups(gs => gs?.map(g => g.workingDir !== workingDir ? g : { ...g, tasks: g.tasks.map(x => x.id === id ? { ...x, status: action === 'enable' } : x) }) ?? gs);
    try { await api('POST', `/api/cron/${action}`, { workingDir, id }); }
    catch (e: any) { toast(`${t('schedule.actionFailed')}：${e?.message || e}`, 'error'); }
    void load(true);
  };
  const toggleExpand = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  /** 点击左侧事件：右栏滚动定位到对应任务卡片并短暂高亮；单栏模式下先切到任务视图再定位 */
  const locate = (taskId: string) => {
    setTab('tasks');
    requestAnimationFrame(() => {
      const el = rightRef.current?.querySelector<HTMLElement>(`[data-cron="${CSS.escape(taskId)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-accent');
      setTimeout(() => el.classList.remove('ring-2', 'ring-accent'), 1600);
    });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col @container">
      <div className={cn('h-11 shrink-0 flex items-center gap-2 px-4 border-b border-border', sidebarCollapsed && 'pl-12')}>
        <span className="text-sm font-medium">{t('schedule.title')}</span>
        <span className="flex-1" />
        <div className="flex items-center gap-1 @3xl:hidden">
          {(['timeline', 'tasks'] as const).map(k => (
            <button key={k} onClick={() => setTab(k)}
              className={cn('h-6 px-2 rounded-md text-xs', tab === k ? 'bg-black/[0.07] text-fg' : 'text-muted hover:text-fg hover:bg-black/[0.05]')}>
              {t(k === 'timeline' ? 'schedule.tabTimeline' : 'schedule.tabTasks')}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex">
        <aside className={cn('overflow-y-auto', tab === 'timeline' ? 'flex-1' : 'hidden',
          '@3xl:block @3xl:flex-none @3xl:w-[clamp(240px,24cqw,360px)] @3xl:border-r @3xl:border-border')}>
          <div className="px-4 pt-4 pb-1 text-xs font-medium text-muted">{t('schedule.upcoming')}</div>
          {events.length === 0 ? (
            <div className="px-4 py-6 text-xs text-muted">{t('schedule.noUpcoming')}</div>
          ) : (
            <div className="px-2 pb-4 flex flex-col">
              {events.map((ev, i) => {
                const newDay = i === 0 || dayKey(ev.ts) !== dayKey(events[i - 1].ts);
                return (
                  <div key={`${ev.taskId}-${ev.ts}`}>
                    {newDay && <div className="px-2 pt-3 pb-1 text-xs font-medium text-fg">{dayLabel(ev.ts, now)}</div>}
                    <button onClick={() => locate(ev.taskId)}
                      className="w-full text-left px-2 py-1.5 rounded-md hover:bg-black/[0.04] flex items-start gap-2">
                      <span className="font-mono text-xs text-accent pt-0.5 shrink-0">{fmtTime(ev.ts)}</span>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-[13px] text-fg" title={ev.name}>{ev.name}</span>
                        <span className="block truncate text-[11px] text-muted">{ev.projectName}</span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
        <div ref={rightRef} className={cn('min-h-0 overflow-y-auto', tab === 'tasks' ? 'flex-1' : 'hidden', '@3xl:block @3xl:flex-1')}>
          <div className="max-w-3xl mx-auto p-4 @5xl:p-6 flex flex-col gap-6">
            {groups === null ? (
              <div className="flex items-center justify-center py-10 text-muted"><Spinner className="h-4 w-4" /></div>
            ) : groups.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-sm text-muted gap-2"><CalendarClock size={26} className="text-fg" />{t('schedule.empty')}</div>
            ) : groups.map(g => (
              <section key={g.workingDir}>
                <div className="flex items-center gap-2 mb-2 min-w-0">
                  <Folder size={14} className="shrink-0 text-muted" />
                  <span className="font-medium truncate min-w-0 @5xl:shrink-0 @5xl:max-w-[45%]" title={g.workingDir}>{g.projectName}</span>
                  <span className="hidden @5xl:inline text-xs text-muted truncate" title={g.workingDir}>{shortPath(g.workingDir)}</span>
                  <span className="flex-1" />
                  {g.latestSessionId && (
                    <Button size="sm" variant="ghost" title={t('schedule.openSession')} onClick={() => setView({ type: 'chat', sessionId: g.latestSessionId! })}>
                      <span className="hidden @5xl:inline">{t('schedule.openSession')}</span> <ArrowUpRight size={13} />
                    </Button>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {sortCronTasks(g.tasks).map(task => (
                    <CronTaskCard key={task.id} task={task}
                      expanded={expanded.has(task.id)} onToggleExpand={() => toggleExpand(task.id)}
                      onToggle={v => act(g.workingDir, v ? 'enable' : 'disable', task.id)}
                      onDelete={() => act(g.workingDir, 'delete', task.id)}
                      onEdit={task.filePath && g.latestSessionId ? () => {
                        const r = parseCronFileRef(task.filePath!, g.workingDir);
                        if (!r) return;
                        setView({ type: 'chat', sessionId: g.latestSessionId! });
                        openFileTab(g.latestSessionId!, r.path, r.line, r.endLine);
                      } : undefined} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

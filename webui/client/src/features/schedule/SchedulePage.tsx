import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Folder, ArrowUpRight } from 'lucide-react';
import type { CronGroup } from '../../../../shared/types';
import { useApp } from '../../store/app';
import { api } from '../../api/http';
import { Spinner, Button } from '../../common/ui';
import { t } from '../../i18n';
import { CronTaskCard, parseCronFileRef } from '../panel/CronTaskCard';
import { sortCronTasks } from '../panel/CronTab';

/** 日程页：全部项目将要触发的定时任务（worker 是否存活对用户透明，由 keeper 保证到点拉起） */
export function SchedulePage() {
  const cronUpdates = useApp(s => s.cronUpdates);
  const registry = useApp(s => s.registry);
  const toast = useApp(s => s.toast);
  const setView = useApp(s => s.setView);
  const openFileTab = useApp(s => s.openFileTab);
  const [groups, setGroups] = useState<CronGroup[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = async (silent = false) => {
    try { setGroups(await api<CronGroup[]>('GET', '/api/cron')); }
    catch (e: any) { if (!silent) toast(`${t('cron.loadFailed')}：${e?.message || e}`, 'error'); }
  };
  // 首次 + 任一目录 cron:update + 注册表变化时重拉
  const version = useMemo(() => Object.values(cronUpdates).reduce((a, b) => a + b, 0), [cronUpdates]);
  useEffect(() => { void load(groups !== null); }, [version, registry.projects.length, registry.sessions.length]);

  const act = async (workingDir: string, action: 'delete' | 'enable' | 'disable', id: string) => {
    // 启停乐观更新；删除等 cron:update 刷新
    if (action !== 'delete') setGroups(gs => gs?.map(g => g.workingDir !== workingDir ? g : { ...g, tasks: g.tasks.map(x => x.id === id ? { ...x, status: action === 'enable' } : x) }) ?? gs);
    try { await api('POST', `/api/cron/${action}`, { workingDir, id }); }
    catch (e: any) { toast(`${t('schedule.actionFailed')}：${e?.message || e}`, 'error'); }
    void load(true);
  };
  const toggleExpand = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-11 shrink-0 flex items-center gap-2 px-4 border-b border-border">
        <CalendarClock size={15} />
        <span className="text-sm font-medium">{t('schedule.title')}</span>
        <span className="text-xs text-muted">{t('schedule.hint')}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6 flex flex-col gap-6">
          {groups === null ? (
            <div className="flex items-center justify-center py-10 text-muted"><Spinner className="h-4 w-4" /></div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-sm text-muted gap-2"><CalendarClock size={26} className="text-fg" />{t('schedule.empty')}</div>
          ) : groups.map(g => (
            <section key={g.workingDir}>
              <div className="flex items-center gap-2 mb-2 min-w-0">
                <Folder size={14} className="shrink-0 text-muted" />
                <span className="font-medium truncate">{g.projectName}</span>
                <span className="text-xs text-muted truncate" title={g.workingDir}>{g.workingDir}</span>
                <span className="flex-1" />
                {g.latestSessionId && (
                  <Button size="sm" variant="ghost" onClick={() => setView({ type: 'chat', sessionId: g.latestSessionId! })}>
                    {t('schedule.openSession')} <ArrowUpRight size={13} />
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
  );
}

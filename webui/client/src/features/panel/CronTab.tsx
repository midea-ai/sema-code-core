import { useEffect, useMemo, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import type { CronTask } from '../../../../shared/types';
import { useApp, PanelTab } from '../../store/app';
import { wsClient } from '../../api/ws';
import { Spinner } from '../../common/ui';
import { t } from '../../i18n';
import { CronTaskCard, parseCronFileRef } from './CronTaskCard';

/** 启用的在前、关闭的在后；同组内按下次触发时间升序（无触发时间的靠后） */
export function sortCronTasks(tasks: CronTask[]): CronTask[] {
  return [...tasks].sort((a, b) => {
    if (a.status !== b.status) return a.status ? -1 : 1;
    return (a.nextFireAt[0] ?? Infinity) - (b.nextFireAt[0] ?? Infinity);
  });
}

/** 「定时任务」标签：展示当前项目（workingDir）的全部定时任务，支持启停/删除/定位到持久化文件 */
export function CronTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const workingDir = useApp(s => s.registry.sessions.find(x => x.id === sessionId)?.workingDir || '');
  const version = useApp(s => s.cronUpdates[workingDir] || 0);
  const toast = useApp(s => s.toast);
  const openFileTab = useApp(s => s.openFileTab);
  const [tasks, setTasks] = useState<CronTask[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const load = async (silent = false) => {
    try { setTasks(await wsClient.request<CronTask[]>('session.getCronTasks', sessionId, {})); }
    catch (e: any) { if (!silent) toast(`${t('cron.loadFailed')}：${e?.message || e}`, 'error'); }
  };
  // 首次 + cron:update（同项目）时重拉
  useEffect(() => { void load(version > 0); }, [sessionId, version]);

  // 卡片「打开」跳转 → 展开并滚动到该任务
  useEffect(() => {
    if (!tab.focusId || !tasks) return;
    setExpanded(prev => new Set(prev).add(tab.focusId!));
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-cron="${tab.focusId}"]`)?.scrollIntoView({ block: 'center' }));
  }, [tab.focusId, tab.focusSeq, tasks === null]);

  const sorted = useMemo(() => sortCronTasks(tasks || []), [tasks]);

  const toggleTask = async (id: string, enabled: boolean) => {
    setTasks(prev => prev?.map(x => x.id === id ? { ...x, status: enabled } : x) ?? prev);
    try { await wsClient.request(enabled ? 'session.enableCronTask' : 'session.disableCronTask', sessionId, { id }); }
    catch (e: any) { toast(e?.message || String(e), 'error'); void load(true); }
  };
  const deleteTask = async (id: string) => {
    try { await wsClient.request('session.deleteCronTask', sessionId, { id }); }
    catch (e: any) { toast(e?.message || String(e), 'error'); }
    // 列表由 cron:update 触发刷新；兜底再拉一次
    void load(true);
  };
  const toggleExpand = (id: string) => setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div ref={listRef} className="flex-1 min-h-0 overflow-auto p-2 flex flex-col gap-2">
        {tasks === null ? (
          <div className="flex items-center justify-center py-10 text-muted"><Spinner className="h-4 w-4" /></div>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-sm text-muted gap-2"><Clock size={24} className="text-fg" />{t('cron.empty')}</div>
        ) : sorted.map(task => (
          <CronTaskCard key={task.id} task={task}
            expanded={expanded.has(task.id)} onToggleExpand={() => toggleExpand(task.id)}
            onToggle={v => toggleTask(task.id, v)} onDelete={() => deleteTask(task.id)}
            onEdit={task.filePath ? () => { const r = parseCronFileRef(task.filePath!, workingDir); if (r) openFileTab(sessionId, r.path, r.line, r.endLine); } : undefined} />
        ))}
      </div>
    </div>
  );
}


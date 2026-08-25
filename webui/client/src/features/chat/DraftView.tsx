import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, Search, Check, Plus, X } from 'lucide-react';
import { useApp } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { Composer } from './Composer';
import { Popover, cn } from '../../common/ui';
import { CreateProjectDialog } from '../../common/CreateProjectDialog';
import { t } from '../../i18n';

/** 新会话草稿页：不创建会话记录，首次发送时由 Composer 创建并跳转；顶部可选择所属项目 */
export function DraftView({ projectId }: { projectId?: string }) {
  const project = useApp(s => projectId ? s.registry.projects.find(p => p.id === projectId) : undefined);
  const modelData = useApp(s => s.modelData);
  const setView = useApp(s => s.setView);
  const hasModel = !!modelData?.modelList?.length;
  const sidebarCollapsed = useApp(s => s.sidebarCollapsed);
  // Design 是新会话页的一种形态：Composer 里切模式即就地切换本页文案，会话仍在首次发送时创建
  const isDesign = useSessions(s => s.draftAgentMode) === 'Design';
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className={cn('h-11 shrink-0 flex items-center gap-2 px-4 border-b border-border', sidebarCollapsed && 'pl-12')}>
        <span className="font-medium">{t('sidebar.newSession')}</span>
        {project && <span className="text-xs text-muted truncate hidden md:inline" title={project.workingDir}>{project.workingDir}</span>}
      </div>
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-center gap-3 p-8">
        <div className="text-2xl font-semibold inline-flex items-center gap-2">
          {isDesign ? t('chat.emptyTitleDesign') : t('chat.emptyTitle')}
          {isDesign && <span className="text-[11px] leading-none px-1.5 py-1 rounded bg-design/10 text-design font-medium">Design</span>}
        </div>
        <div className="text-muted max-w-md">{isDesign ? t('chat.emptyHintDesign') : project ? t('draft.projectHint', { name: project.name }) : t('chat.emptyHint')}</div>
        {!hasModel && modelData && (
          <button onClick={() => setView({ type: 'settings', tab: 'models' })} className="h-9 px-4 rounded-md border border-border text-sm hover:bg-black/[0.05]">{t('chat.goConfigModel')}</button>
        )}
      </div>
      {/* 输入框上方：浅灰底带 + 项目选择胶囊，底带与下方输入卡片相接（对齐参考效果）；
          未配置模型警告条会插在两者之间时，去掉负 margin 避免贴住警告条 */}
      <div className="shrink-0 px-4">
        <div className="max-w-3xl mx-auto px-3">
          <div className={cn('rounded-t-xl bg-black/[0.035] px-2.5 pt-2 pb-5 flex items-center gap-2', !hasModel && modelData ? undefined : '-mb-4')}>
            <ProjectPicker projectId={projectId} onChange={id => setView({ type: 'draft', projectId: id })} />
          </div>
        </div>
      </div>
      <Composer projectId={projectId} />
    </div>
  );
}

/** 项目选择器：可搜索；底部「新建项目」，已选项目时可「不在项目中工作」切回独立会话 */
function ProjectPicker({ projectId, onChange }: { projectId?: string; onChange: (id?: string) => void }) {
  const projects = useApp(s => s.registry.projects);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = projects.find(p => p.id === projectId);

  const sorted = useMemo(() => [...projects].sort((a, b) => b.lastActiveAt - a.lastActiveAt), [projects]);
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? sorted.filter(p => p.name.toLowerCase().includes(k) || p.workingDir.toLowerCase().includes(k)) : sorted;
  }, [sorted, q]);
  const items = filtered;

  const open = () => { setQ(''); setHi(0); setRect(btn.current!.getBoundingClientRect()); };
  const close = () => setRect(null);
  useEffect(() => { if (rect) setTimeout(() => input.current?.focus(), 0); }, [rect]);
  useEffect(() => { setHi(0); }, [q]);

  const pick = (id?: string) => { onChange(id); close(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(items.length - 1, h + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = items[hi]; if (it) pick(it.id); }
  };

  const newProject = () => { close(); setCreating(true); };

  return (
    <>
      <button ref={btn} onClick={open} title={t('draft.pickProject')}
        className={cn('inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[13px] max-w-64 transition-colors', current ? 'text-fg/80 hover:text-fg' : 'text-dim hover:text-muted')}>
        <Folder size={14} className="shrink-0" strokeWidth={1.75} />
        <span className="truncate">{current ? current.name : t('draft.pickProject')}</span>
      </button>
      <Popover anchor={rect} onClose={close} className="p-1.5! rounded-xl! shadow-[0_8px_30px_rgba(0,0,0,0.12)]! w-64">
        <div className="flex items-center gap-2 h-8 px-2 mb-1">
          <Search size={13} className="text-muted/70 shrink-0" />
          <input ref={input} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder={t('draft.searchProject')}
            className="flex-1 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-muted/60" />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {items.length === 0 && <div className="px-2 py-1.5 text-xs text-muted">{t('draft.noMatch')}</div>}
          {items.map((p, i) => (
            <button key={p.id} onClick={() => pick(p.id)} onMouseEnter={() => setHi(i)} title={p.workingDir}
              className={cn('w-full flex items-center gap-2 h-8 px-2 rounded-lg text-left text-[13px]', i === hi && 'bg-black/[0.05]')}>
              <Folder size={14} className="text-fg/80 shrink-0" strokeWidth={1.75} />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === projectId && <Check size={13} className="text-fg shrink-0" />}
            </button>
          ))}
        </div>
        <div className="my-1 mx-1 border-t border-border" />
        <button onClick={newProject} className="w-full flex items-center gap-2 h-8 px-2 rounded-lg text-left text-[13px] hover:bg-black/[0.05]">
          <Plus size={14} className="text-fg/80 shrink-0" strokeWidth={1.75} />{t('sidebar.newProject')}
        </button>
        {current && (
          <button onClick={() => pick(undefined)} className="w-full flex items-center gap-2 h-8 px-2 rounded-lg text-left text-[13px] hover:bg-black/[0.05]">
            <X size={14} className="text-fg/80 shrink-0" strokeWidth={1.75} />{t('draft.leaveProject')}
          </button>
        )}
      </Popover>
      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} onCreated={p => onChange(p.id)} />
    </>
  );
}

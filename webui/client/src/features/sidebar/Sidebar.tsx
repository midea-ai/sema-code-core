import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Settings, CalendarClock, ChevronDown, MessageSquare, Folder, PanelLeft, MoreHorizontal } from 'lucide-react';
import { useApp } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { pendingBlocks } from '../../../../shared/transcript';
import type { ProjectRecord, SessionRecord } from '../../../../shared/types';
import { Popover, MenuItem, MenuSep, useContextMenu, useDialog, cn, relTime } from '../../common/ui';
import { t } from '../../i18n';
import { CreateProjectDialog } from '../../common/CreateProjectDialog';

/** 侧栏布局持久化（项目展开集合 + 两个分组开合），刷新后保持不变 */
const LAYOUT_KEY = 'sema.webui.sidebar';
function loadLayout(): { expanded: Record<string, boolean>; projectsOpen: boolean; sessionsOpen: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    return { expanded: v.expanded || {}, projectsOpen: v.projectsOpen !== false, sessionsOpen: v.sessionsOpen !== false };
  } catch { return { expanded: {}, projectsOpen: true, sessionsOpen: true }; }
}

export function Sidebar({ width }: { width: number }) {
  const registry = useApp(s => s.registry);
  const view = useApp(s => s.view);
  const setView = useApp(s => s.setView);
  const setSidebarCollapsed = useApp(s => s.setSidebarCollapsed);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadLayout().expanded);
  const [projectsOpen, setProjectsOpen] = useState(() => loadLayout().projectsOpen);
  const [sessionsOpen, setSessionsOpen] = useState(() => loadLayout().sessionsOpen);
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ expanded, projectsOpen, sessionsOpen }));
  }, [expanded, projectsOpen, sessionsOpen]);

  const projects = useMemo(() => [...registry.projects].sort((a, b) => b.lastActiveAt - a.lastActiveAt), [registry.projects]);
  const standalone = useMemo(() => registry.sessions.filter(s => !s.projectId).sort((a, b) => b.lastActiveAt - a.lastActiveAt), [registry.sessions]);
  const byProject = useMemo(() => {
    const m: Record<string, SessionRecord[]> = {};
    for (const s of registry.sessions) if (s.projectId) (m[s.projectId] ||= []).push(s);
    for (const k of Object.keys(m)) m[k].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return m;
  }, [registry.sessions]);

  // 新会话只切到草稿页，首次发送时才创建记录（避免堆积空会话）
  const newSession = (projectId?: string) => {
    if (projectId) setExpanded(e => ({ ...e, [projectId]: true }));
    setView({ type: 'draft', projectId });
  };

  // 新建项目弹窗（名称 + 可选源文件夹，覆盖原「新建 / 导入」两个入口）
  const [creating, setCreating] = useState(false);

  const activeId = view.type === 'chat' ? view.sessionId : undefined;

  return (
    <aside style={{ width }} className="shrink-0 h-full flex flex-col border-r border-border bg-panel">
      {/* Design 模式会话图标的七彩渐变描边（跨 svg 引用，仅需定义一次） */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
        <defs>
          <linearGradient id="design-session-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ff5c5c" />
            <stop offset="25%" stopColor="#ffb648" />
            <stop offset="50%" stopColor="#5cd68c" />
            <stop offset="75%" stopColor="#4ea1ff" />
            <stop offset="100%" stopColor="#9575ff" />
          </linearGradient>
        </defs>
      </svg>
      <div className="p-2 pb-0.5 flex flex-col gap-0.5">
        <div className="flex items-center justify-between px-2 h-8 mb-1.5">
          <span className="text-base font-semibold tracking-wide">{t('app.name')}</span>
          <button onClick={() => setSidebarCollapsed(true)} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.05]" title="隐藏侧边栏"><PanelLeft size={15} /></button>
        </div>
        <NavItem icon={<Plus size={15} />} label={t('sidebar.newSession')} active={view.type === 'draft' && !view.projectId} onClick={() => newSession()} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
        {/* 非固定入口：配置及后续新增入口，随列表一起滚动 */}
        <NavItem icon={<Settings size={15} />} label={t('sidebar.settings')} active={view.type === 'settings'} onClick={() => setView({ type: 'settings', tab: 'models' })} />
        <NavItem icon={<CalendarClock size={15} />} label={t('sidebar.schedule')} active={view.type === 'schedule'} onClick={() => setView({ type: 'schedule' })} />

        {/* 项目 */}
        <SectionHeader label={t('sidebar.projects')} className="mt-2" open={projectsOpen} onToggle={() => setProjectsOpen(v => !v)} action={
          <button onClick={() => setCreating(true)} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.05]" title={t('sidebar.newProject')}><Plus size={14} /></button>
        } />
        <CreateProjectDialog open={creating} onClose={() => setCreating(false)} onCreated={p => { setProjectsOpen(true); setExpanded(e => ({ ...e, [p.id]: true })); }} />
        {projectsOpen && projects.length === 0 && <div className="px-2 py-1 text-xs text-muted">{t('sidebar.noProjects')}</div>}
        {projectsOpen && projects.map(p => (
          <ProjectNode key={p.id} project={p} sessions={byProject[p.id] || []} expanded={!!expanded[p.id]}
            onToggle={() => setExpanded(e => ({ ...e, [p.id]: !e[p.id] }))} activeId={activeId} onNewSession={() => newSession(p.id)} />
        ))}

        {/* 独立会话 */}
        <SectionHeader label={t('sidebar.sessions')} className="mt-4" open={sessionsOpen} onToggle={() => setSessionsOpen(v => !v)} action={
          <button onClick={() => newSession()} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.05]" title={t('sidebar.newSession')}><Plus size={14} /></button>
        } />
        {sessionsOpen && standalone.length === 0 && <div className="px-2 py-1 text-xs text-muted">{t('sidebar.noSessions')}</div>}
        {sessionsOpen && standalone.map(s => <SessionItem key={s.id} session={s} active={s.id === activeId} />)}
      </div>
    </aside>
  );
}

function NavItem({ icon, label, onClick, active }: { icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} className={cn('flex items-center gap-2 h-8 px-2 rounded-md text-sm w-full text-left hover:bg-black/[0.05]', active ? 'bg-black/[0.06] text-fg' : 'text-fg/90')}>
      {icon}<span>{label}</span>
    </button>
  );
}

/** 分组标题：标题 + 折叠箭头（悬浮显示，折叠时常显）；右侧操作（如新建）悬浮显示 */
function SectionHeader({ label, action, className, open = true, onToggle }: { label: string; action?: React.ReactNode; className?: string; open?: boolean; onToggle?: () => void }) {
  return (
    <div className={cn('group flex items-center h-7 px-2 text-sm text-dim select-none', className)}>
      <button onClick={onToggle} className="inline-flex items-center gap-1">
        <span>{label}</span>
        <ChevronDown size={12} className={cn('transition-transform', !open && '-rotate-90', open && 'opacity-0 group-hover:opacity-100')} />
      </button>
      <span className="flex-1" />
      <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100">{action}</span>
    </div>
  );
}

/** 项目节点默认展示的会话数 */
const PROJECT_SESSIONS_PREVIEW = 5;

/** 移除项目确认框里的「连带删除文件夹」勾选项（仅 WebUI 受管目录显示） */
function DeleteFilesOption({ onChange }: { onChange: (v: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <label className="inline-flex items-center gap-2 text-sm cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={e => { setChecked(e.target.checked); onChange(e.target.checked); }} />
      {t('dialog.removeProjectDeleteFiles')}
    </label>
  );
}

function ProjectNode({ project, sessions, expanded, onToggle, activeId, onNewSession }: {
  project: ProjectRecord; sessions: SessionRecord[]; expanded: boolean; onToggle: () => void; activeId?: string; onNewSession: () => void;
}) {
  const menu = useContextMenu();
  const dialog = useDialog();
  const toast = useApp(s => s.toast);
  const app = useApp.getState;
  // 默认只显示前 N 个会话，点「展开显示」看全部；当前会话不在前 N 个时自动展开
  const [showAllManual, setShowAll] = useState(false);
  // 项目收起后重置，再展开时回到只显示前 N 个
  useEffect(() => { if (!expanded) setShowAll(false); }, [expanded]);
  const showAll = showAllManual || sessions.findIndex(s => s.id === activeId) >= PROJECT_SESSIONS_PREVIEW;
  const rename = async () => {
    const name = await dialog.prompt({ title: t('menu.rename'), defaultValue: project.name });
    if (name && name !== project.name) app().renameProject(project.id, name).catch(e => toast(e.message, 'error'));
  };
  const remove = async () => {
    const del = { current: false };
    const ok = await dialog.confirm({
      title: t('menu.remove'), danger: true, okText: t('menu.remove'),
      message: t(project.managedWorkingDir ? 'dialog.confirmRemoveProjectManaged' : 'dialog.confirmRemoveProject', { name: project.name }),
      extra: project.managedWorkingDir ? <DeleteFilesOption onChange={v => { del.current = v; }} /> : undefined,
    });
    if (ok) app().removeProject(project.id, del.current).catch(e => toast(e.message, 'error'));
  };
  return (
    <div>
      <div onContextMenu={menu.open} onClick={onToggle}
        className={cn('group flex items-center gap-1.5 h-7 px-2 rounded-md text-sm cursor-pointer select-none',
          !expanded && sessions.some(s => s.id === activeId) ? 'bg-black/[0.07]' : 'hover:bg-black/[0.05]')} title={project.workingDir}>
        <Folder size={14} className="text-muted shrink-0" />
        <span className="truncate flex-1">{project.name}</span>
        <button onClick={e => { e.stopPropagation(); onNewSession(); }} className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted hover:text-fg" title={t('menu.newSessionHere')}><Plus size={13} /></button>
        <button onClick={e => { e.stopPropagation(); menu.open(e); }} className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted hover:text-fg"><MoreHorizontal size={13} /></button>
      </div>
      {expanded && (
        <div className="ml-4 pl-1">
          {sessions.length === 0 && <div className="px-2 py-1 text-xs text-muted">{t('sidebar.projectSessionsEmpty')}</div>}
          {(showAll ? sessions : sessions.slice(0, PROJECT_SESSIONS_PREVIEW)).map(s => <SessionItem key={s.id} session={s} active={s.id === activeId} />)}
          {sessions.length > PROJECT_SESSIONS_PREVIEW && !showAll && (
            <button onClick={() => setShowAll(true)} className="h-7 px-2 text-xs text-dim hover:text-fg text-left w-full">{t('sidebar.showAll')}</button>
          )}
        </div>
      )}
      <Popover anchor={menu.pos} onClose={menu.close}>
        <MenuItem onClick={() => { menu.close(); onNewSession(); }}>{t('menu.newSessionHere')}</MenuItem>
        <MenuItem onClick={() => { menu.close(); rename(); }}>{t('menu.rename')}</MenuItem>
        <MenuItem onClick={() => { menu.close(); app().revealProject(project.id).catch(e => toast(e.message, 'error')); }}>{t('menu.reveal')}</MenuItem>
        <MenuSep />
        <MenuItem danger onClick={() => { menu.close(); remove(); }}>{t('menu.remove')}</MenuItem>
      </Popover>
    </div>
  );
}

/** 悬浮多久后弹出会话详情面板 */
const HOVER_CARD_DELAY = 450;

function SessionItem({ session, active }: { session: SessionRecord; active: boolean }) {
  const setView = useApp(s => s.setView);
  const snap = useSessions(s => s.snapshots[session.id]);
  const status = useApp(s => s.status[session.id]);
  const live = useApp(s => !!s.liveSessions[session.id]);
  const project = useApp(s => session.projectId ? s.registry.projects.find(p => p.id === session.projectId) : undefined);
  const menu = useContextMenu();
  const dialog = useDialog();
  const toast = useApp(s => s.toast);
  const app = useApp.getState;

  // 悬浮：标题溢出时由右向左滑动显示全文；延时弹出详情面板（完整标题 / 时间 / 所在项目）
  const rowRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  const [card, setCard] = useState<DOMRect | null>(null);
  const timer = useRef<number>();
  const onEnter = () => {
    const el = titleRef.current;
    const overflow = el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
    setShift(overflow);
    // 标题未溢出（不跑马灯）时不弹详情面板
    if (!overflow) return;
    timer.current = window.setTimeout(() => { if (rowRef.current) setCard(rowRef.current.getBoundingClientRect()); }, HOVER_CARD_DELAY);
  };
  const onLeave = () => { setShift(0); setCard(null); window.clearTimeout(timer.current); };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const state = snap?.state ?? status?.state;
  const pending = snap ? pendingBlocks(snap).length : (status?.pending ?? 0);
  const doneUnread = useApp(s => !!s.doneUnread[session.id]);

  const rename = async () => {
    const title = await dialog.prompt({ title: t('menu.rename'), defaultValue: session.title });
    if (title !== null && title !== session.title) app().renameSession(session.id, title).catch(e => toast(e.message, 'error'));
  };
  const remove = async () => {
    const ok = await dialog.confirm({
      title: t('menu.delete'), danger: true, okText: t('menu.delete'),
      message: session.projectId
        ? t('dialog.confirmDeleteSession', { name: session.title || t('chat.untitled') })
        : `${t('dialog.confirmDeleteSession', { name: session.title || t('chat.untitled') })}\n${t('dialog.deleteStandaloneHint')}`,
    });
    if (ok) app().deleteSession(session.id).catch(e => toast(e.message, 'error'));
  };

  return (
    <>
      <div ref={rowRef} onClick={() => setView({ type: 'chat', sessionId: session.id })} onContextMenu={menu.open}
        onMouseEnter={onEnter} onMouseLeave={onLeave}
        className={cn('group flex items-center gap-1.5 h-7 px-1.5 rounded-md text-sm cursor-pointer select-none', active ? 'bg-black/[0.07]' : 'hover:bg-black/[0.05]')}>
        <MessageSquare size={13} className={cn('shrink-0', session.agentMode !== 'Design' && 'text-muted', !live && 'opacity-30')}
          color={session.agentMode === 'Design' ? 'url(#design-session-gradient)' : undefined} />
        <span className="flex-1 min-w-0 overflow-hidden">
          <span ref={titleRef} className={cn('block whitespace-nowrap', shift ? 'w-max' : 'truncate')}
            style={{ transform: `translateX(-${shift}px)`, transition: shift ? `transform ${Math.max(0.6, shift / 40)}s linear 0.3s` : 'none' }}>
            {session.title || t('chat.untitled')}
          </span>
        </span>
        {pending > 0 ? <span className="h-2 w-2 rounded-full bg-warn shrink-0" title="待应答" />
          : state === 'processing' ? <span className="h-2 w-2 rounded-full bg-accent pulse shrink-0" title="处理中" />
            : doneUnread ? <span className="h-2 w-2 rounded-full bg-ok shrink-0" title="已完成" /> : null}
        <span className="text-[10px] text-muted shrink-0 group-hover:hidden">{relTime(session.lastActiveAt)}</span>
        <button onClick={e => { e.stopPropagation(); menu.open(e); }} className="hidden group-hover:block p-0.5 rounded text-muted hover:text-fg"><MoreHorizontal size={13} /></button>
      </div>
      <Popover anchor={menu.pos} onClose={menu.close}>
        <MenuItem onClick={() => { menu.close(); rename(); }}>{t('menu.rename')}</MenuItem>
        <MenuItem onClick={() => { menu.close(); app().revealSession(session.id).catch(e => toast(e.message, 'error')); }}>{t('menu.reveal')}</MenuItem>
        <MenuSep />
        <MenuItem danger onClick={() => { menu.close(); remove(); }}>{t('menu.delete')}</MenuItem>
      </Popover>
      {card && !menu.pos && createPortal(
        <div style={{ position: 'fixed', left: card.right + 8, top: card.top - 8, zIndex: 1200, width: 260 }}
          className="pointer-events-none bg-white border border-border rounded-lg shadow-xl px-3 py-2 text-sm">
          <div className="break-words whitespace-pre-wrap leading-snug">{session.title || t('chat.untitled')}</div>
          {project && (
            <div className="flex items-center gap-1.5 mt-2 text-xs text-dim" title={project.workingDir}>
              <Folder size={12} className="shrink-0" /><span className="truncate">{project.name}</span>
            </div>
          )}
          <div className="mt-1 text-[10px] text-dim">{relTime(session.lastActiveAt)}</div>
        </div>,
        document.body,
      )}
    </>
  );
}

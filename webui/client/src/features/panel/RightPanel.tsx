import { useEffect, useRef, useState } from 'react';
import { Globe, Files, GitCompare, TerminalSquare, Bot, Clock, MessageCircleQuestion, X, Plus, ChevronLeft, ChevronRight, RotateCw, ExternalLink, PanelRight } from 'lucide-react';
import { useApp, PanelTab } from '../../store/app';
import { cn, Popover, MenuItem } from '../../common/ui';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { api, getToken } from '../../api/http';
import { fileUrlToProxy, isPrivateUrl, normalizeUrl } from '../../common/url';
import { t } from '../../i18n';
import { ReviewTab } from './ReviewTab';
import { FileTab } from './FileTab';
import { TerminalTab } from './TerminalTab';
import { AgentTab } from './AgentTab';
import { CronTab } from './CronTab';
import { QuickchatTab } from './QuickchatTab';

function TabIcon({ tab, size = 12, className }: { tab: PanelTab; size?: number; className?: string }) {
  // 文件标签已打开具体文件时用文件类型 logo，未选文件时仍用统一 Files 图标
  if (tab.type === 'files' && tab.path) return <FileIcon fileName={tab.path} size={size} className={className} />;
  if (tab.type === 'browser' && tab.icon) return <SiteFavicon url={tab.icon} size={size} className={className} />;
  const Icon = tab.type === 'review' ? GitCompare : tab.type === 'files' ? Files : tab.type === 'terminal' ? TerminalSquare : tab.type === 'agent' ? Bot : tab.type === 'cron' ? Clock : tab.type === 'quickchat' ? MessageCircleQuestion : Globe;
  return <Icon size={size} className={className} />;
}

/** 浏览器标签的站点图标：经服务端代理加载页面声明的图标，失败回退地球 */
function SiteFavicon({ url, size, className }: { url: string; size: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  if (failed) return <Globe size={size} className={className} />;
  return <img src={`/api/favicon?url=${encodeURIComponent(url)}&token=${encodeURIComponent(getToken())}`} alt="" width={size} height={size} className={cn('rounded-sm', className)} onError={() => setFailed(true)} />;
}

/** draft：项目草稿页模式，sessionId 实为项目 id，隐藏依赖会话的评审/定时任务入口 */
export function RightPanel({ sessionId, width, draft }: { sessionId: string; width: number; draft?: boolean }) {
  const panel = useApp(s => s.panels[sessionId]) || { tabs: [], collapsed: true };
  const updatePanel = useApp(s => s.updatePanel);
  const openReviewTab = useApp(s => s.openReviewTab);
  const openCronTab = useApp(s => s.openCronTab);
  const openQuickchatTab = useApp(s => s.openQuickchatTab);
  const active = panel.tabs.find(t => t.id === panel.activeId) || panel.tabs[0];
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const addTab = (type: 'browser' | 'files' | 'terminal') => updatePanel(sessionId, p => {
    const id = `${type[0]}${Date.now()}`;
    const tab: PanelTab = type === 'files' ? { id, type, path: '', history: [], index: -1 } : { id, type, history: [], index: -1 };
    return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
  });
  const closeTab = (id: string) => updatePanel(sessionId, p => {
    const closing = p.tabs.find(t => t.id === id);
    if (closing?.termId) api('DELETE', `/api/terminals/${closing.termId}`).catch(() => undefined);
    const tabs = p.tabs.filter(t => t.id !== id);
    const activeId = p.activeId === id ? tabs[tabs.length - 1]?.id : p.activeId;
    return { ...p, tabs, activeId };
  });
  const moveTab = (id: string, to: number) => updatePanel(sessionId, p => {
    const from = p.tabs.findIndex(t => t.id === id);
    if (from < 0) return p;
    const tabs = [...p.tabs];
    const [tab] = tabs.splice(from, 1);
    tabs.splice(from < to ? to - 1 : to, 0, tab);
    return { ...p, tabs };
  });

  // 激活标签滚入视野
  useEffect(() => { stripRef.current?.querySelector<HTMLElement>(`[data-tab="${active?.id}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' }); }, [active?.id]);

  const openMenu = (e: React.MouseEvent<HTMLElement>) => setMenu(e.currentTarget.getBoundingClientRect());
  const newMenu = (
    <Popover anchor={menu} onClose={() => setMenu(null)} align="right" className="w-44">
      <MenuItem onClick={() => { setMenu(null); addTab('terminal'); }}><span className="inline-flex items-center gap-2"><TerminalSquare size={14} />{t('panel.terminal')}</span></MenuItem>
      <MenuItem onClick={() => { setMenu(null); addTab('browser'); }}><span className="inline-flex items-center gap-2"><Globe size={14} />{t('panel.browser')}</span></MenuItem>
      <MenuItem onClick={() => { setMenu(null); addTab('files'); }}><span className="inline-flex items-center gap-2"><Files size={14} />{t('panel.files')}</span></MenuItem>
      {!draft && <MenuItem onClick={() => { setMenu(null); openReviewTab(sessionId); }}><span className="inline-flex items-center gap-2"><GitCompare size={14} />{t('panel.review')}</span></MenuItem>}
      {!draft && <MenuItem onClick={() => { setMenu(null); openCronTab(sessionId); }}><span className="inline-flex items-center gap-2"><Clock size={14} />{t('panel.cron')}</span></MenuItem>}
      {!draft && <MenuItem onClick={() => { setMenu(null); openQuickchatTab(sessionId); }}><span className="inline-flex items-center gap-2"><MessageCircleQuestion size={14} />{t('panel.quickchat')}</span></MenuItem>}
    </Popover>
  );

  if (panel.collapsed) {
    return (
      <div className="w-10 shrink-0 border-l border-border flex flex-col items-center py-2 gap-2 bg-white">
        <button onClick={() => updatePanel(sessionId, p => ({ ...p, collapsed: false }))} className="p-1.5 rounded text-muted hover:text-fg hover:bg-black/[0.05]" title="显示侧边栏"><PanelRight size={16} /></button>
        <button onClick={openMenu} className="p-1.5 rounded text-muted hover:text-fg hover:bg-black/[0.05]" title={t('panel.newTab')}><Plus size={16} /></button>
        {newMenu}
      </div>
    );
  }

  return (
    <div style={{ width, maxWidth: '70%' }} className="shrink-0 border-l border-border flex flex-col bg-white">
      {/* 标签栏：可拖动换位、关闭；过多时横向滚动；高度与中间聊天头部（h-11）一致 */}
      <div className="h-11 shrink-0 flex items-center gap-1 px-1.5">
        <div ref={stripRef} onWheel={e => { if (e.deltaY && stripRef.current) stripRef.current.scrollLeft += e.deltaY; }}
          className="flex-1 min-w-0 h-full flex items-center gap-0.5 overflow-x-auto scrollbar-none"
          onDragOver={e => { if (dragId) { e.preventDefault(); setDropIdx(panel.tabs.length); } }}
          onDrop={e => { e.preventDefault(); if (dragId && dropIdx !== null) moveTab(dragId, dropIdx); setDragId(null); setDropIdx(null); }}>
          {panel.tabs.map((tab, i) => (
            <div key={tab.id} data-tab={tab.id} draggable
              onDragStart={e => { setDragId(tab.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragEnd={() => { setDragId(null); setDropIdx(null); }}
              onDragOver={e => { if (!dragId) return; e.preventDefault(); e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setDropIdx(e.clientX < r.left + r.width / 2 ? i : i + 1); }}
              onClick={() => updatePanel(sessionId, p => ({ ...p, activeId: tab.id }))}
              className={cn('group relative flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-md text-xs cursor-pointer max-w-44 shrink-0 select-none',
                tab.id === active?.id ? 'bg-black/[0.07] text-fg' : 'text-muted hover:text-fg hover:bg-black/[0.05]',
                dragId === tab.id && 'opacity-40',
                dropIdx === i && dragId && dragId !== tab.id && 'before:absolute before:left-0 before:top-1 before:bottom-1 before:w-0.5 before:bg-accent',
                dropIdx === i + 1 && i === panel.tabs.length - 1 && dragId && dragId !== tab.id && 'after:absolute after:right-0 after:top-1 after:bottom-1 after:w-0.5 after:bg-accent')}>
              <TabIcon tab={tab} className="shrink-0" />
              <span className="truncate">{tab.title || tabLabel(tab)}</span>
              <button onClick={e => { e.stopPropagation(); closeTab(tab.id); }} className={cn('p-0.5 rounded hover:bg-black/[0.08]', tab.id === active?.id ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100')}><X size={11} /></button>
            </div>
          ))}
        </div>
        <button onClick={openMenu} className="h-7 w-7 flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-black/[0.05] shrink-0" title={t('panel.newTab')}><Plus size={14} /></button>
        <button onClick={() => updatePanel(sessionId, p => ({ ...p, collapsed: true }))} className="h-7 w-7 flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-black/[0.05] shrink-0" title="隐藏侧边栏"><PanelRight size={15} /></button>
        {newMenu}
      </div>
      {/* 内容 */}
      <div className="flex-1 min-h-0 flex flex-col">
        {active?.type === 'review' ? <ReviewTab key={active.id} sessionId={sessionId} tab={active} />
          : active?.type === 'files' ? <FileTab key={active.id} sessionId={sessionId} tab={active} />
          : active?.type === 'terminal' ? <TerminalTab key={active.id} sessionId={sessionId} tab={active} />
          : active?.type === 'agent' ? <AgentTab key={active.id} sessionId={sessionId} tab={active} />
          : active?.type === 'cron' ? <CronTab key={active.id} sessionId={sessionId} tab={active} />
          : active?.type === 'quickchat' ? <QuickchatTab key={active.id} sessionId={sessionId} />
          : active ? <BrowserTab key={active.id} sessionId={sessionId} tab={active} /> : (
            <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted p-6 gap-4">
              <div className="text-base font-medium text-fg">{t('panel.emptyTitle')}</div>
              <div className="flex gap-2">
                <button onClick={() => addTab('terminal')} className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-border hover:bg-black/[0.05] text-fg text-xs"><TerminalSquare size={13} />{t('panel.terminal')}</button>
                <button onClick={() => addTab('browser')} className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-border hover:bg-black/[0.05] text-fg text-xs"><Globe size={13} />{t('panel.browser')}</button>
                <button onClick={() => addTab('files')} className="h-8 px-3 inline-flex items-center gap-1.5 rounded-md border border-border hover:bg-black/[0.05] text-fg text-xs"><Files size={13} />{t('panel.files')}</button>
              </div>
              <div className="max-w-xs text-xs">{t('panel.emptyHint')}</div>
            </div>
          )}
      </div>
    </div>
  );
}

function tabLabel(tab: PanelTab) {
  if (tab.type === 'review') return t('panel.review');
  if (tab.type === 'files') return tab.path?.split('/').pop() || t('panel.files');
  if (tab.type === 'terminal') return t('panel.terminal');
  if (tab.type === 'agent') return t('panel.agent');
  if (tab.type === 'cron') return t('panel.cron');
  if (tab.type === 'quickchat') return t('panel.quickchat');
  if (!tab.url) return t('panel.browser');
  try {
    const u = new URL(tab.url);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname.split('/').pop() || tab.url);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch { return tab.url; }
}

function BrowserTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const updatePanel = useApp(s => s.updatePanel);
  const openExternal = useApp(s => s.openExternal);
  const [input, setInput] = useState(tab.url || '');
  const [loadKey, setLoadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timerRef = useRef<number>();

  useEffect(() => { setInput(tab.url || ''); }, [tab.url]);

  const setTab = (fn: (t: PanelTab) => PanelTab) => updatePanel(sessionId, p => ({ ...p, tabs: p.tabs.map(x => x.id === tab.id ? fn(x) : x) }));

  const navigate = async (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    // 手动输入的地址一律在面板内加载，不跳系统浏览器；禁止内嵌的站点（X-Frame-Options / CSP）由探测结果
    // 直接显示「禁止内嵌」占位和「在系统浏览器打开」按钮（跨域 iframe 加载失败前端感知不到，只能靠探测）
    setBlocked(false);
    setTab(x => { const history = [...x.history.slice(0, x.index + 1), url]; return { ...x, url, title: undefined, icon: undefined, history, index: history.length - 1 }; });
    setLoadKey(k => k + 1);
    if (!url.startsWith('file://') && !isPrivateUrl(url)) {
      let embeddable = true;
      try { embeddable = (await api<{ embeddable: boolean }>('POST', '/api/probe-url', { url })).embeddable; } catch { /* 探测失败不打扰，交给 iframe 自行加载 */ }
      if (!embeddable) setBlocked(true);
    }
  };
  const go = (delta: number) => setTab(x => { const index = Math.max(0, Math.min(x.history.length - 1, x.index + delta)); return { ...x, index, url: x.history[index], title: undefined, icon: undefined }; });
  const reload = () => { setBlocked(false); setLoadKey(k => k + 1); };

  // 加载检测：无法读取跨域 iframe 的成功状态，用超时 + load 事件近似
  useEffect(() => {
    if (!tab.url) return;
    setLoading(true);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setLoading(false), 8000);
    return () => window.clearTimeout(timerRef.current);
  }, [tab.url, loadKey]);

  // 标签名与图标：iframe 跨域读不到 document.title / <link rel=icon>，由服务端抓页面头部解析；取不到时回退 host+path / 地球
  useEffect(() => {
    if (!tab.url || !/^(https?|file):\/\//i.test(tab.url)) return;
    const url = tab.url;
    let alive = true;
    api<{ title: string; icon: string }>('POST', '/api/page-meta', { url })
      .then(r => { if (alive) setTab(x => x.url === url ? { ...x, title: r.title || x.title, icon: r.icon || x.icon } : x); })
      .catch(() => {});
    return () => { alive = false; };
  }, [tab.url, loadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onLoad = () => {
    setLoading(false);
    // 同源才能探测；被 X-Frame-Options 拒绝时 Chrome 会加载空文档，contentDocument 可访问但为空
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc && doc.URL === 'about:blank' && tab.url) setBlocked(true);
    } catch { /* 跨域正常 */ }
  };

  return (
    <>
      <div className="h-9 shrink-0 flex items-center gap-1 px-1.5 border-b border-border">
        <button onClick={() => go(-1)} disabled={tab.index <= 0} className="p-1 rounded text-muted hover:text-fg disabled:opacity-30"><ChevronLeft size={15} /></button>
        <button onClick={() => go(1)} disabled={tab.index >= tab.history.length - 1} className="p-1 rounded text-muted hover:text-fg disabled:opacity-30"><ChevronRight size={15} /></button>
        <button onClick={reload} className={cn('p-1 rounded text-muted hover:text-fg', loading && 'animate-spin')}><RotateCw size={13} /></button>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') navigate(input); }}
          placeholder={t('panel.urlPlaceholder')} className="flex-1 h-7 px-2 rounded-md bg-panel border border-transparent text-xs focus:border-accent focus:bg-white" />
        <button onClick={() => tab.url && openExternal(tab.url).catch(() => window.open(tab.url, '_blank', 'noopener'))} disabled={!tab.url} className="p-1 rounded text-muted hover:text-fg disabled:opacity-30" title={t('panel.openExternal')}><ExternalLink size={14} /></button>
      </div>
      <div className="flex-1 min-h-0 relative bg-white">
        {tab.url ? (
          <>
            {/* 本地文件走 /api/local 代理；且不给 allow-same-origin（不透明源），防内嵌页脚本借同源拿 token 调 API */}
            <iframe ref={iframeRef} key={loadKey} onLoad={onLoad} title="preview" className="w-full h-full border-0"
              src={tab.url.startsWith('file://') ? fileUrlToProxy(tab.url, getToken()) : tab.url}
              sandbox={tab.url.startsWith('file://') ? 'allow-scripts allow-popups allow-modals allow-downloads' : 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads'} />
            {blocked && (
              <div className="absolute inset-0 bg-white flex flex-col items-center justify-center text-sm text-muted gap-3 p-6 text-center">
                <div>{t('panel.blocked')}</div>
                <button onClick={() => openExternal(tab.url!).catch(() => window.open(tab.url, '_blank', 'noopener'))} className="h-8 px-3 rounded-md border border-border hover:bg-black/[0.05] text-fg text-xs">{t('panel.openExternal')}</button>
              </div>
            )}
          </>
        ) : (
          <div className="absolute inset-0 bg-white flex flex-col items-center justify-center text-sm text-muted gap-2 p-6 text-center">
            <Globe size={30} className="text-fg" />
            <div className="text-base font-medium text-fg">{t('panel.startBrowse')}</div>
            <div className="max-w-xs">{t('panel.onlyLoopback')}</div>
          </div>
        )}
      </div>
    </>
  );
}

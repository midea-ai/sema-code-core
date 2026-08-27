/**
 * 插件页：市场（内置资源一键安装到用户级）+ 已安装（用户级全量 MCP / 技能管理）。
 * 已安装交互对齐 vscode 插件的 MCP / Skill 页：技能 = 编辑（页内右侧面板改 SKILL.md）+ 删除 + 开关；
 * MCP = 编辑（JSON 弹窗）+ 删除 + 开关。开关走 core 的分层禁用语义：写用户级
 * ~/.sema/settings.json 的 disabledSkills / disabledMcpServers，全局生效，CLI / IDE 插件同样认。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, MoreHorizontal, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../../api/http';
import { useApp, PanelTab } from '../../store/app';
import { Button, Modal, Popover, MenuItem, Spinner, Toggle, cn, useDialog } from '../../common/ui';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { usePanelWidth, ResizeHandle } from '../../common/Resizer';
import { FileTab } from '../panel/FileTab';
import { t } from '../../i18n';
import type { EcoItem, EcoInstalled, EcoInstalledMcp, EcoMcpTool, EcoMcpStatus } from '../../../../shared/types';

/** 插件页文件窗口的面板作用域：server 端把该 id 解析到用户级技能目录 ~/.sema/skills */
const ECO_SCOPE = '~skills';

/** MCP 工具列表每页条数（对齐 vscode 插件） */
const TOOLS_PAGE_SIZE = 8;

export function EcoPage() {
  const sidebarCollapsed = useApp(s => s.sidebarCollapsed);
  const [tab, setTab] = useState<'market' | 'installed'>('market');
  // 市场卡片「管理」跳转：带上目标资源切到已安装页，InstalledTab 挂载时选中对应分组并打开技能文件；
  // 手动切标签则清掉，避免旧跳转在重新挂载时复放
  const [manage, setManage] = useState<{ kind: 'skill' | 'mcp'; id: string } | null>(null);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className={cn('h-11 shrink-0 flex items-center gap-2 px-4 border-b border-border', sidebarCollapsed && 'pl-12')}>
        <TabBtn active={tab === 'market'} onClick={() => { setManage(null); setTab('market'); }}>{t('eco.tabMarket')}</TabBtn>
        <TabBtn active={tab === 'installed'} onClick={() => { setManage(null); setTab('installed'); }}>{t('eco.tabInstalled')}</TabBtn>
      </div>
      {tab === 'market'
        ? <MarketTab onManage={item => { setManage({ kind: item.kind, id: item.id }); setTab('installed'); }} />
        : <InstalledTab initial={manage} />}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cn('h-7 px-2.5 rounded-md text-sm', active ? 'bg-black/[0.07] text-fg' : 'text-muted hover:text-fg hover:bg-black/[0.05]')}>{children}</button>;
}

/** GitHub 官方 mark（octicon mark-github，16 viewBox），lucide 的品牌图标已废弃形状不对 */
function GithubIcon({ size = 12, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/** 名称哈希出稳定颜色的首字母图标（对齐 vscode 插件页样式） */
function NameIcon({ name }: { name: string }) {
  const hue = useMemo(() => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }, [name]);
  return (
    <div className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center text-white text-sm font-semibold" style={{ backgroundColor: `hsl(${hue} 55% 55%)` }}>
      {(name[0] || '?').toUpperCase()}
    </div>
  );
}

// ==================== 市场 ====================

/** 分类展示顺序；不在列表里的归入「其他」 */
const CAT_ORDER = ['doc', 'office', 'writing', 'dev', 'web', 'mobile', 'design', 'media', 'network'] as const;
function catLabel(c: string): string {
  switch (c) {
    case 'doc': return t('eco.catDoc');
    case 'office': return t('eco.catOffice');
    case 'writing': return t('eco.catWriting');
    case 'dev': return t('eco.catDev');
    case 'web': return t('eco.catWeb');
    case 'mobile': return t('eco.catMobile');
    case 'design': return t('eco.catDesign');
    case 'media': return t('eco.catMedia');
    case 'network': return t('eco.catNetwork');
    default: return t('eco.catOther');
  }
}

function MarketTab({ onManage }: { onManage: (item: EcoItem) => void }) {
  const toast = useApp(s => s.toast);
  const dialog = useDialog();
  const [items, setItems] = useState<EcoItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 安装/卸载中的卡片集合：多个远程安装可并行，各卡片独立转圈，单值会互相覆盖
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const setBusy = (id: string, busy: boolean) => setBusyIds(prev => {
    const next = new Set(prev);
    busy ? next.add(id) : next.delete(id);
    return next;
  });
  const [query, setQuery] = useState('');

  const refresh = () => api<EcoItem[]>('GET', '/api/eco/catalog').then(items => { setItems(items); setError(null); });
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);

  const q = query.trim().toLowerCase();
  const filtered = (items || []).filter(i => !q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
  const groups = [...CAT_ORDER, 'other'].map(key => ({
    key,
    label: catLabel(key),
    items: filtered.filter(i => ((CAT_ORDER as readonly string[]).includes(i.category || '') ? i.category : 'other') === key),
  })).filter(g => g.items.length > 0);

  const install = async (item: EcoItem) => {
    setBusy(item.id, true);
    try {
      const r = await api<{ needConfirm?: boolean } | true>('POST', '/api/eco/install', { id: item.id });
      if (typeof r === 'object' && r?.needConfirm) {
        const ok = await dialog.confirm({ title: t('eco.install'), okText: t('eco.overwrite'), message: t('eco.confirmOverwrite', { name: item.name }) });
        if (!ok) return;
        await api('POST', '/api/eco/install', { id: item.id, overwrite: true });
      }
      toast(t(item.kind === 'skill' ? 'eco.installedNow' : 'eco.installed', { name: item.name }));
      await refresh();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(item.id, false); }
  };

  const uninstall = async (item: EcoItem) => {
    const ok = await dialog.confirm({ title: t('eco.uninstall'), danger: true, okText: t('eco.uninstall'), message: t('eco.confirmUninstall', { name: item.name }) });
    if (!ok) return;
    setBusy(item.id, true);
    try {
      await api('POST', '/api/eco/uninstall', { id: item.id });
      toast(t(item.kind === 'skill' ? 'eco.uninstalledNow' : 'eco.uninstalled', { name: item.name }));
      await refresh();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(item.id, false); }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6">
        {/* 搜索框 */}
        <div className="flex items-center mb-2">
          <span className="flex-1" />
          <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-border bg-white w-56">
            <Search size={13} className="text-muted shrink-0" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('eco.search')} className="flex-1 min-w-0 bg-transparent outline-none text-sm" />
            {query && <button onClick={() => setQuery('')} className="text-muted hover:text-fg"><X size={13} /></button>}
          </div>
        </div>
        {!items && error && (
          <div className="text-sm text-danger flex items-center gap-3">
            <span>{t('eco.loadFailed', { error })}</span>
            <Button size="sm" onClick={() => refresh().catch(e => setError(e.message))}>{t('common.retry')}</Button>
          </div>
        )}
        {!items && !error && <div className="text-muted text-sm flex items-center gap-2"><Spinner />{t('common.loading')}</div>}
        {items && groups.length === 0 && <div className="text-muted text-sm">{q ? t('eco.noMatch') : t('eco.empty')}</div>}
        {groups.map(g => (
          <section key={g.key}>
            <div className="flex items-baseline gap-2 mt-5 mb-3">
              <h2 className="text-sm font-semibold">{g.label}</h2>
              <span className="text-xs text-muted">{g.items.length}</span>
            </div>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
              {g.items.map(item => (
                <MarketCard key={`${item.kind}:${item.id}`} item={item} busy={busyIds.has(item.id)}
                  onInstall={() => install(item)} onUninstall={() => uninstall(item)} onManage={() => onManage(item)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function MarketCard({ item, busy, onInstall, onUninstall, onManage }: {
  item: EcoItem; busy: boolean; onInstall: () => void; onUninstall: () => void; onManage: () => void;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div className="rounded-xl border border-border bg-white p-4 flex flex-col gap-2.5 hover:shadow-sm transition-shadow">
      <div className="flex items-center gap-2.5">
        <NameIcon name={item.name} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm truncate">{item.name}</div>
          <div className="text-[10px] text-muted truncate">{item.kind === 'skill' ? `${item.skillName || item.id} ${t('eco.kindSkill')}` : `${item.id} MCP`}</div>
        </div>
      </div>
      <div className="text-xs text-muted leading-relaxed flex-1"
        style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={item.description}>
        {item.description}
      </div>
      <div className="flex items-center gap-2">
        {item.repoUrl && (
          <a href={item.repoUrl} target="_blank" rel="noopener noreferrer" title={item.repoUrl}
            className="inline-flex items-center gap-1 min-w-0 text-[11px] text-muted hover:text-fg hover:underline">
            <GithubIcon size={12} className="shrink-0" /><span className="truncate">{item.repo}</span>
          </a>
        )}
        <span className="flex-1" />
        {item.installed ? (
          // 已安装态：「⋯」菜单（管理 / 卸载），卸载中变转圈
          <div className="flex items-center">
            {busy ? (
              <span className="p-1.5 text-muted"><Spinner /></span>
            ) : (
              <button onClick={e => setAnchor(e.currentTarget.getBoundingClientRect())}
                className="p-1.5 rounded-md text-muted hover:text-fg hover:bg-black/[0.06]">
                <MoreHorizontal size={14} />
              </button>
            )}
            <Popover anchor={anchor} onClose={() => setAnchor(null)} align="right">
              <MenuItem onClick={() => { setAnchor(null); onManage(); }}>{t('eco.manage')}</MenuItem>
              <MenuItem danger onClick={() => { setAnchor(null); onUninstall(); }}>{t('eco.uninstall')}</MenuItem>
            </Popover>
          </div>
        ) : (
          <Button variant="primary" size="sm" className="min-w-16" disabled={busy} onClick={onInstall}>
            {busy ? <Spinner /> : t('eco.install')}
          </Button>
        )}
      </div>
    </div>
  );
}

// ==================== 已安装 ====================

function InstalledTab({ initial }: { initial: { kind: 'skill' | 'mcp'; id: string } | null }) {
  const toast = useApp(s => s.toast);
  const dialog = useDialog();
  const [data, setData] = useState<EcoInstalled | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [group, setGroup] = useState<'mcp' | 'skill'>(initial?.kind || 'skill');
  const [query, setQuery] = useState('');
  const [editingMcp, setEditingMcp] = useState<EcoInstalledMcp | null>(null);
  // MCP 行的展开状态 + 各 server 的工具探测结果（懒加载：首次展开才短连探测，server 端按配置缓存）
  const [expandedMcp, setExpandedMcp] = useState<Set<string>>(new Set());
  const [mcpTools, setMcpTools] = useState<Record<string, { loading?: boolean; error?: string; tools?: EcoMcpTool[] }>>({});
  // 实时连接状态（来自配置 worker 里 core 的常驻连接）：进页面拉一次，带 tools 的填进 mcpTools，展开免探测。
  // clearId：该 server 以本次结果为准（启停响应），旧工具缓存先清掉；其余仅补充不覆盖（保留探测结果）
  const [mcpLive, setMcpLive] = useState<Record<string, { connectStatus: EcoMcpStatus['connectStatus']; error?: string; filePath?: string }>>({});
  // 启停进行中的 server（enable 要等 core 连接完成，冷启动可达数秒）：期间开关禁用防连点
  const [mcpBusy, setMcpBusy] = useState<Set<string>>(new Set());
  const applyLiveStatus = (list: EcoMcpStatus[], clearId?: string) => {
    setMcpLive(Object.fromEntries(list.map(s => [s.id, { connectStatus: s.connectStatus, error: s.error, filePath: s.filePath }])));
    setMcpTools(prev => {
      const next = { ...prev };
      if (clearId) delete next[clearId];
      for (const s of list) if (s.tools?.length && !next[s.id]?.tools) next[s.id] = { tools: s.tools };
      return next;
    });
  };
  const loadLiveStatus = () => {
    api<EcoMcpStatus[]>('GET', '/api/eco/installed/mcp/status').then(applyLiveStatus).catch(() => undefined);
  };
  // 事件驱动（对齐 vscode 模式，零轮询）：core 每次连接状态变化 emit mcp:server:status，
  // 经 worker → WS 广播到 store 计数自增，这里跟着重拉一次；300ms 防抖合并连接期的密集事件。挂载时也走这条路径拉首帧
  const mcpStatusUpdate = useApp(s => s.mcpStatusUpdate);
  useEffect(() => {
    const timer = window.setTimeout(loadLiveStatus, mcpStatusUpdate === 0 ? 0 : 300);
    return () => window.clearTimeout(timer);
  }, [mcpStatusUpdate]);
  // 右侧文件窗口：复用会话面板的 store 与 FileTab，作用域为 ~skills（无加号、无收起）
  const panel = useApp(s => s.panels[ECO_SCOPE]) || { tabs: [], collapsed: false };
  const updatePanel = useApp(s => s.updatePanel);
  const [panelW, setPanelW] = usePanelWidth('ecoPanel', 520, 320, 1200);
  const activeTab = panel.tabs.find(tb => tb.id === panel.activeId) || panel.tabs[0];

  const refresh = () => api<EcoInstalled>('GET', '/api/eco/installed').then(d => { setData(d); setError(null); });
  useEffect(() => { refresh().catch(e => setError(e.message)); }, []);

  const q = query.trim().toLowerCase();
  const match = (x: { name: string; description: string; title?: string }) =>
    !q || x.name.toLowerCase().includes(q) || (x.title || '').toLowerCase().includes(q) || x.description.toLowerCase().includes(q);
  const skills = (data?.skills || []).filter(match);
  const mcp = (data?.mcp || []).filter(match);

  const run = async (fn: () => Promise<any>) => {
    try { await fn(); await refresh(); } catch (e: any) { toast(e.message, 'error'); }
  };

  const closeTab = (id: string) => updatePanel(ECO_SCOPE, s => {
    const tabs = s.tabs.filter(tb => tb.id !== id);
    return { ...s, tabs, activeId: s.activeId === id ? tabs[tabs.length - 1]?.id : s.activeId };
  });

  const removeItem = async (kind: 'skill' | 'mcp', item: { id: string; name: string }) => {
    const ok = await dialog.confirm({ title: t('eco.delete'), danger: true, okText: t('eco.delete'), message: t('eco.confirmUninstall', { name: item.name }) });
    if (!ok) return;
    await run(() => api('POST', '/api/eco/installed/remove', { kind, id: item.id }));
    // 技能删除后关掉它已打开的文件标签
    if (kind === 'skill') updatePanel(ECO_SCOPE, s => {
      const tabs = s.tabs.filter(tb => !(tb.path || '').startsWith(`${item.id}/`));
      return { ...s, tabs, activeId: tabs.some(tb => tb.id === s.activeId) ? s.activeId : tabs[tabs.length - 1]?.id };
    });
  };

  /** 打开技能的 SKILL.md：同路径标签复用，否则新开（无加号入口，标签只从这里产生） */
  const openSkillFile = (item: { id: string }) => {
    const p = `${item.id}/SKILL.md`;
    updatePanel(ECO_SCOPE, s => {
      const exist = s.tabs.find(tb => tb.type === 'files' && tb.path === p);
      if (exist) return { ...s, collapsed: false, activeId: exist.id };
      const tab: PanelTab = { id: `f${Date.now()}`, type: 'files', path: p, title: item.id, history: [], index: -1 };
      return { ...s, collapsed: false, tabs: [...s.tabs, tab], activeId: tab.id };
    });
  };

  // 市场「管理」跳转来的：技能挂载时自动打开对应文件（等同手动点「打开」）；
  // MCP 关掉右侧文件窗口，等列表加载后自动展开对应行并探测工具。
  // 市场卡片 id 是清单文件名，与安装后的 server key 不一定相同（当前资源约定同名），找不到就不展开
  useEffect(() => {
    if (initial?.kind === 'skill') openSkillFile({ id: initial.id });
    if (initial?.kind === 'mcp') updatePanel(ECO_SCOPE, s => ({ ...s, tabs: [], activeId: undefined }));
  }, []);
  const mcpJumped = useRef(false);
  useEffect(() => {
    if (mcpJumped.current || initial?.kind !== 'mcp' || !data) return;
    mcpJumped.current = true;
    const hit = data.mcp.find(m => m.id === initial.id);
    if (hit) {
      // 只展开目标行（选中态跟随展开态），其余全部收起
      setExpandedMcp(new Set([hit.id]));
      if (!mcpTools[hit.id]?.tools && !mcpTools[hit.id]?.loading) loadTools(hit.id);
    }
  }, [data]);

  const loadTools = (id: string, refresh = false) => {
    setMcpTools(prev => ({ ...prev, [id]: { ...prev[id], loading: true, error: undefined } }));
    api<EcoMcpTool[]>('POST', '/api/eco/installed/mcp/tools', { id, refresh })
      .then(tools => {
        setMcpTools(prev => ({ ...prev, [id]: { tools } }));
        loadLiveStatus(); // 探测成功说明服务能拉起，顺带重新同步一次连接状态，避免状态点停留在过期的 connecting
      })
      .catch(e => setMcpTools(prev => ({ ...prev, [id]: { tools: prev[id]?.tools, error: e.message } })));
  };

  const toggleMcpExpand = (id: string) => {
    const opening = !expandedMcp.has(id);
    setExpandedMcp(prev => {
      const next = new Set(prev);
      opening ? next.add(id) : next.delete(id);
      return next;
    });
    if (opening && !mcpTools[id]?.tools && !mcpTools[id]?.loading) loadTools(id);
  };

  /** MCP 行状态点：停用直接灰点；否则优先本地探测动作（loading/error），其次 core 实时连接状态，最后探测结果兜底 */
  const mcpStatus = (item: EcoInstalledMcp) => {
    const st = mcpTools[item.id];
    const lv = mcpLive[item.id];
    const [color, tip, pulse] = !item.enabled ? ['#9ca3af', t('eco.connDisabled'), false]
      : st?.loading ? ['#f59e0b', t('eco.probeLoading'), true]
      : st?.error ? ['#ef4444', t('eco.probeFailed', { error: st.error }), false]
      : lv?.connectStatus === 'connected' ? ['#10b981', t('eco.connOk'), false]
      : lv?.connectStatus === 'connecting' ? ['#f59e0b', t('eco.connConnecting'), true]
      : lv?.connectStatus === 'error' ? ['#ef4444', t('eco.connFailed', { error: lv.error || '' }), false]
      : st?.tools ? ['#10b981', t('eco.probeOk'), false]
      : lv ? ['#9ca3af', t('eco.connIdle'), false]
      : ['#9ca3af', t('eco.probeIdle'), false];
    return <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', pulse && 'animate-pulse')} style={{ backgroundColor: color as string }} title={tip as string} />;
  };

  /** 探测成功后描述前的启用工具数：[5 Tools]；停用不显示 */
  const mcpToolCount = (item: EcoInstalledMcp) => {
    const tools = mcpTools[item.id]?.tools;
    if (!tools || !item.enabled) return null;
    const enabled = tools.filter(tl => item.useTools == null || item.useTools.includes(tl.name)).length;
    return <span className="text-[10px] text-muted shrink-0">{t('eco.toolCount', { n: enabled })}</span>;
  };

  /** 打开 MCP 配置文件并定位：core 的 filePath 是 "路径:起始行-结束行" 定位串（找不到范围时为纯路径） */
  const openFileTab = useApp(s => s.openFileTab);
  const openMcpFile = (item: EcoInstalledMcp) => {
    const fp = mcpLive[item.id]?.filePath;
    if (!fp) return;
    const m = fp.match(/^(.+):(\d+)-(\d+)$/);
    m ? openFileTab(ECO_SCOPE, m[1], Number(m[2]), Number(m[3])) : openFileTab(ECO_SCOPE, fp);
  };

  /** 单工具开关：useTools null=全部可用；全部勾上时写回 null（回到缺省态，与 core 语义一致） */
  const toggleMcpTool = async (item: EcoInstalledMcp, toolName: string, enabled: boolean) => {
    const all = (mcpTools[item.id]?.tools || []).map(tl => tl.name);
    const cur = new Set(item.useTools == null ? all : item.useTools);
    enabled ? cur.add(toolName) : cur.delete(toolName);
    const next = all.every(n => cur.has(n)) ? null : all.filter(n => cur.has(n));
    // 乐观更新本地状态；失败时 toast + 重拉兜底回滚
    setData(d => d ? { ...d, mcp: d.mcp.map(m => m.id === item.id ? { ...m, useTools: next } : m) } : d);
    try { await api('PUT', '/api/eco/installed/mcp/use-tools', { id: item.id, toolNames: next }); }
    catch (e: any) { toast(e.message, 'error'); refresh().catch(() => undefined); }
  };

  return (
    <div className="flex-1 min-h-0 flex">
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6">
          {/* 分组 tab（带数量）+ 搜索框 */}
          <div className="flex items-center gap-1 mb-4">
            <GroupBtn active={group === 'skill'} count={data?.skills.length} onClick={() => setGroup('skill')}>{t('eco.kindSkill')}</GroupBtn>
            <GroupBtn active={group === 'mcp'} count={data?.mcp.length} onClick={() => setGroup('mcp')}>MCP</GroupBtn>
            <span className="flex-1" />
            <div className="flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-border bg-white w-56">
              <Search size={13} className="text-muted shrink-0" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('eco.search')} className="flex-1 min-w-0 bg-transparent outline-none text-sm" />
              {query && <button onClick={() => setQuery('')} className="text-muted hover:text-fg"><X size={13} /></button>}
            </div>
          </div>

          {!data && error && (
            <div className="text-sm text-danger flex items-center gap-3">
              <span>{t('eco.loadFailed', { error })}</span>
              <Button size="sm" onClick={() => refresh().catch(e => setError(e.message))}>{t('common.retry')}</Button>
            </div>
          )}
          {!data && !error && <div className="text-muted text-sm flex items-center gap-2"><Spinner />{t('common.loading')}</div>}

          {data && group === 'mcp' && (
            mcp.length === 0 ? <div className="text-muted text-sm">{q ? t('eco.noMatch') : t('eco.noInstalled')}</div> : (
              <div className="flex flex-col">
                {mcp.map(item => (
                  <div key={item.id}>
                    <InstalledRow name={item.name} title={item.title} description={item.description}
                      active={expandedMcp.has(item.id)}
                      expanded={expandedMcp.has(item.id)} status={mcpStatus(item)} descPrefix={mcpToolCount(item)}
                      onClick={() => toggleMcpExpand(item.id)}
                      menu={[
                        // 刷新：强制重连探测工具列表；面板没展开时顺带展开，让结果可见
                        { label: t('eco.toolsRefresh'), onClick: () => { setExpandedMcp(prev => new Set(prev).add(item.id)); loadTools(item.id, true); } },
                        // 打开配置文件并定位到该 server 的行范围；core 未上报 filePath（如状态还没拉到）时不展示
                        ...(mcpLive[item.id]?.filePath ? [{ label: t('eco.openFile'), onClick: () => openMcpFile(item) }] : []),
                        { label: t('eco.edit'), onClick: () => setEditingMcp(item) },
                        { label: t('eco.delete'), danger: true, onClick: () => removeItem('mcp', item) },
                      ]}
                      toggle={<Toggle checked={item.enabled} disabled={mcpBusy.has(item.id)} onChange={v => run(async () => {
                        setMcpBusy(prev => new Set(prev).add(item.id));
                        try {
                          // 响应即权威状态：core 断/连完成才返回（enable 冷启动会等几秒），直接替换本地状态
                          const status = await api<EcoMcpStatus[]>('POST', '/api/eco/installed/toggle', { kind: 'mcp', id: item.id, enabled: v });
                          applyLiveStatus(status, item.id);
                          setExpandedMcp(prev => { const next = new Set(prev); next.delete(item.id); return next; });
                        } finally {
                          setMcpBusy(prev => { const next = new Set(prev); next.delete(item.id); return next; });
                        }
                      })} />} />
                    {expandedMcp.has(item.id) && (
                      <McpToolsPanel item={item} state={mcpTools[item.id]}
                        onRefresh={() => loadTools(item.id, true)}
                        onToggle={(tool, v) => toggleMcpTool(item, tool, v)} />
                    )}
                  </div>
                ))}
              </div>
            )
          )}
          {data && group === 'skill' && (
            skills.length === 0 ? <div className="text-muted text-sm">{q ? t('eco.noMatch') : t('eco.noInstalled')}</div> : (
              <div className="flex flex-col">
                {skills.map(item => (
                  <InstalledRow key={item.id} name={item.name} title={item.title} description={item.description}
                    active={(activeTab?.path || '').startsWith(`${item.id}/`)}
                    onClick={() => openSkillFile(item)}
                    menu={[
                      { label: t('eco.open'), onClick: () => openSkillFile(item) },
                      { label: t('eco.delete'), danger: true, onClick: () => removeItem('skill', item) },
                    ]}
                    toggle={<Toggle checked={item.enabled} onChange={v => run(() => api('POST', '/api/eco/installed/toggle', { kind: 'skill', id: item.id, enabled: v }))} />} />
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* 页内右侧：文件窗口（复用会话面板的 FileTab；无加号、无收起，标签只从技能行「打开」产生） */}
      {activeTab && (
        <>
          <ResizeHandle side="right" width={panelW} onResize={setPanelW} />
          <div style={{ width: panelW, maxWidth: '70%' }} className="shrink-0 border-l border-border flex flex-col bg-white">
            <div className="h-11 shrink-0 flex items-center gap-0.5 px-1.5 overflow-x-auto scrollbar-none">
              {panel.tabs.map(tab => (
                <div key={tab.id} onClick={() => updatePanel(ECO_SCOPE, s => ({ ...s, activeId: tab.id }))}
                  className={cn('group flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-md text-xs cursor-pointer max-w-44 shrink-0 select-none',
                    tab.id === activeTab.id ? 'bg-black/[0.07] text-fg' : 'text-muted hover:text-fg hover:bg-black/[0.05]')}>
                  <FileIcon fileName={tab.path || ''} size={12} />
                  <span className="truncate">{tab.title || tab.path}</span>
                  <button onClick={e => { e.stopPropagation(); closeTab(tab.id); }} className="p-0.5 rounded text-muted hover:text-fg"><X size={11} /></button>
                </div>
              ))}
            </div>
            <div className="flex-1 min-h-0 flex flex-col border-t border-border">
              <FileTab key={activeTab.id} sessionId={ECO_SCOPE} tab={activeTab} />
            </div>
          </div>
        </>
      )}

      {/* MCP 配置 JSON 编辑弹窗 */}
      <McpEditModal item={editingMcp} onClose={() => setEditingMcp(null)}
        onSaved={() => { setEditingMcp(null); toast(t('eco.saved')); refresh().catch(() => undefined); }} />
    </div>
  );
}

function GroupBtn({ active, count, onClick, children }: { active: boolean; count?: number; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn('h-8 px-2.5 rounded-md text-sm inline-flex items-center gap-1.5', active ? 'bg-black/[0.07] text-fg font-medium' : 'text-muted hover:text-fg hover:bg-black/[0.05]')}>
      {children}
      {count !== undefined && <span className={cn('text-xs px-1.5 rounded', active ? 'bg-black/[0.08]' : 'bg-black/[0.05]')}>{count}</span>}
    </button>
  );
}

interface RowMenuItem { label: string; danger?: boolean; onClick: () => void }

function InstalledRow({ name, title, description, active, expanded, onClick, menu, toggle, status, descPrefix }: {
  name: string; title?: string; description: string; active?: boolean; expanded?: boolean; onClick?: () => void; menu: RowMenuItem[]; toggle: React.ReactNode; status?: React.ReactNode; descPrefix?: React.ReactNode;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <div onClick={onClick} className={cn('group flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-black/[0.03]', active && 'bg-black/[0.05]', onClick && 'cursor-pointer')}>
      {/* 可展开的行（MCP）：行首角标箭头，展开时旋转 */}
      {expanded !== undefined && (
        <ChevronRight size={14} className={cn('shrink-0 -mr-1.5 text-muted transition-transform', expanded && 'rotate-90')} />
      )}
      <NameIcon name={name} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[15px] font-medium truncate">{name}</span>
          {/* 市场卡片中文名标签：技能名多为英文，补个可读标识 */}
          {title && title !== name && (
            <span className="text-[10px] text-muted bg-black/[0.05] px-1.5 py-px rounded shrink-0">{title}</span>
          )}
          {status}
        </div>
        {(descPrefix || description) && (
          <div className="flex items-center gap-1.5 min-w-0 mt-px">
            {descPrefix}
            {description && <span className="text-xs text-muted truncate" title={description}>{description}</span>}
          </div>
        )}
      </div>
      {/* 操作区拦住冒泡：点 ⋯ / 开关不触发行点击（菜单本身走 portal，不经过这里） */}
      <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
        {/* 悬浮才显示的「⋯」，点开操作菜单；菜单打开时保持可见 */}
        <button onClick={e => setAnchor(e.currentTarget.getBoundingClientRect())}
          className={cn('p-1.5 rounded-md text-muted hover:text-fg hover:bg-black/[0.06]', anchor ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
          <MoreHorizontal size={14} />
        </button>
        {toggle}
      </div>
      <Popover anchor={anchor} onClose={() => setAnchor(null)} align="right">
        {menu.map(m => (
          <MenuItem key={m.label} danger={m.danger} onClick={() => { setAnchor(null); m.onClick(); }}>{m.label}</MenuItem>
        ))}
      </Popover>
    </div>
  );
}

/** MCP 行展开后的工具列表：探测结果 + 每个工具的启用开关（useTools null=全部可用） */
function McpToolsPanel({ item, state, onRefresh, onToggle }: {
  item: EcoInstalledMcp;
  state?: { loading?: boolean; error?: string; tools?: EcoMcpTool[] };
  onRefresh: () => void;
  onToggle: (toolName: string, enabled: boolean) => void;
}) {
  const tools = state?.tools;
  const isOn = (n: string) => item.useTools == null || item.useTools.includes(n);
  const enabledCount = (tools || []).filter(tl => isOn(tl.name)).length;
  // 分页（对齐 vscode 插件：每页 8 条）；refresh 后条数变化时用 clamp 兜底，不需要重置
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil((tools?.length || 0) / TOOLS_PAGE_SIZE));
  const curPage = Math.min(page, totalPages);
  const pagedTools = (tools || []).slice((curPage - 1) * TOOLS_PAGE_SIZE, curPage * TOOLS_PAGE_SIZE);
  return (
    <div className="px-2 pt-1 pb-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold text-muted tracking-wide">
          {tools ? t('eco.toolsHeader', { enabled: enabledCount, total: tools.length }) : t('eco.toolsTitle')}
        </span>
        <span className="flex-1" />
        {state?.loading && <span className="text-muted"><Spinner /></span>}
      </div>
      {state?.error && (
        <div className="py-1.5 text-xs text-danger flex items-center gap-2">
          <span className="min-w-0 truncate" title={state.error}>{t('eco.toolsFailed', { error: state.error })}</span>
          <button onClick={onRefresh} className="shrink-0 underline hover:text-fg">{t('common.retry')}</button>
        </div>
      )}
      {!state?.error && !tools && <div className="py-1.5 text-xs text-muted">{t('common.loading')}</div>}
      {tools && tools.length === 0 && !state?.error && <div className="py-1.5 text-xs text-muted">{t('eco.toolsEmpty')}</div>}
      {tools && tools.length > 0 && (
        <>
          {pagedTools.map(tool => (
            <div key={tool.name} className="flex items-center gap-4 h-8">
              <span className="w-44 shrink-0 text-[13px] font-medium truncate" title={tool.name}>{tool.name}</span>
              <span className="flex-1 min-w-0 text-xs text-muted truncate" title={tool.description}>{tool.description || '-'}</span>
              <Toggle small checked={isOn(tool.name)} onChange={v => onToggle(tool.name, v)} />
            </div>
          ))}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button onClick={() => setPage(Math.max(1, curPage - 1))} disabled={curPage === 1}
                className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06] disabled:opacity-30 disabled:hover:bg-transparent">
                <ChevronLeft size={14} />
              </button>
              <span className="text-xs text-muted">{curPage} / {totalPages}</span>
              <button onClick={() => setPage(Math.min(totalPages, curPage + 1))} disabled={curPage === totalPages}
                className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06] disabled:opacity-30 disabled:hover:bg-transparent">
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function McpEditModal({ item, onClose, onSaved }: { item: EcoInstalledMcp | null; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (item) { setText(JSON.stringify(item.config, null, 2)); setErr(null); } }, [item]);

  const save = async () => {
    let config: any;
    try { config = JSON.parse(text); } catch { setErr(t('eco.invalidJson')); return; }
    setSaving(true);
    try { await api('PUT', '/api/eco/installed/mcp', { id: item!.id, config }); onSaved(); }
    catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  };

  return (
    <Modal open={!!item} onClose={onClose} title={item ? `${t('eco.edit')} ${item.name}` : ''} width={520}>
      <div className="flex flex-col gap-3">
        <textarea value={text} onChange={e => { setText(e.target.value); setErr(null); }} spellCheck={false}
          className="w-full h-56 p-2.5 font-mono text-xs leading-relaxed rounded-md border border-border outline-none resize-none focus:border-black/30" />
        {err && <div className="text-xs text-danger">{err}</div>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button variant="primary" disabled={saving} onClick={save}>{saving ? <Spinner /> : t('eco.save')}</Button>
        </div>
      </div>
    </Modal>
  );
}

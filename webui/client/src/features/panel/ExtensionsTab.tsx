/**
 * 「扩展」标签：当前会话目录 core 实际生效的内容汇总，设置页式的平铺列表（无卡片、无边框容器）：
 *   三个不折叠的分区 上下文（规则、记忆）/ 能力（技能、命令、子代理、工具与 MCP）/ 自动化（钩子），分区标题右侧有一句说明；
 *   每个分区下是带图标的顶层行（名称 / 次行 + 右侧数量 + 折叠箭头），点行展开嵌套内容，嵌套行再缩进一级：
 *   规则 → 正文；记忆 → 条目；技能 → 每个技能一行（开关）；命令 → 每个一行（只读）；子代理 → 每个一行（只读，含内置）；
 *   工具与 MCP → 内置工具（可展开工具列表）+「MCP 服务」小标题 + 每个 server 一行（开关，可展开配置与工具）；
 *   钩子 → 同来源同事件合成一行，次行逐条列命令。
 * 作用域写在次行（用户级 / 项目级 / 来源：插件），不用标签；开关表示是否启用，MCP 行右侧单独写连接状态；停用项不置灰。
 * 空分区不显示，全空时显示整体空态。
 * 口径对齐 IDE 插件配置页：规则、记忆、钩子只读（可跳转文件，外部改完点刷新）；技能、MCP 可启停，
 * 内置工具与 MCP 展开后可按工具开关（列表分页）。
 * 写入层：技能 / MCP 由 core 按所在层决定（项目级项写项目级，用户级 / 插件项写用户级即全局生效）；
 * 内置工具黑名单存 webui settings.disabledTools，全局生效。
 * 数据来自该目录的 worker；项目草稿页的面板按 projectId 开，此时走 project.* 路由。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Brain, ChevronLeft, ChevronRight, FileText, Puzzle, RotateCw, Sparkles, SquareSlash, Webhook, Wrench } from 'lucide-react';
import { useApp, PanelTab } from '../../store/app';
import { wsClient } from '../../api/ws';
import { Caret, Spinner, Toggle, cn } from '../../common/ui';
import { t, type I18nKey } from '../../i18n';
import { MemoryEntries, memoryEntryCount } from './MemoryTab';
import type { WsAction } from '../../../../shared/protocol';
import type { ExtensionsInfo, ExtSkill, ExtMcp, ExtHook, ExtTool } from '../../../../shared/types';

type ExtAction = 'getExtensionsInfo' | 'toggleSkill' | 'toggleMcp' | 'updateMcpUseTools';
/** 排序：内置（含宿主注入）最前，然后项目级（MCP 的 local 与 project 同层）、用户级、插件 */
const SCOPE_ORDER: Record<string, number> = { builtin: 0, project: 1, local: 1, user: 2, plugin: 3 };
const scopeRank = (scope: string) => SCOPE_ORDER[scope] ?? 9;
/** 标签文案：项目级 / 用户级 / 插件 / 内置 */
const scopeLabel = (scope: string) => scope === 'plugin' ? t('ext.scopePlugin') : scope === 'builtin' ? t('ext.scopeBuiltin')
  : scope === 'project' || scope === 'local' ? t('ext.scopeProject') : t('ext.scopeUser');
const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
/** 工具列表每页条数（对齐插件页与 IDE 插件） */
const TOOLS_PAGE_SIZE = 8;
/** 插件项的 core 内部名：MCP 为 plugin:插件名:server名，技能为 插件名:技能名。列表显示短名，完整名放 tooltip */
const splitPluginName = (name: string, kind: 'mcp' | 'skill') => {
  const m = kind === 'mcp' ? name.match(/^plugin:([^:]+):(.+)$/) : name.match(/^([^:]+):(.+)$/);
  return m ? { plugin: m[1], short: m[2] } : null;
};
/** 带单位的计数："22 个工具"；部分未启用时再加 "· 20 启用"，总数不冒充可用数 */
const countText = (unit: I18nKey, total: number, on: number) => t(unit, { n: total }) + (on < total ? ` · ${t('ext.enabledOf', { n: on })}` : '');
const countOn = (list: { enabled: boolean }[]) => list.filter(x => x.enabled).length;

interface HookGroup { key: string; event: string; source: ExtHook['source']; pluginName?: string; entries: ExtHook[] }

export function ExtensionsTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const openFileTab = useApp(s => s.openFileTab);
  const toast = useApp(s => s.toast);
  const settings = useApp(s => s.settings);
  const saveSettings = useApp(s => s.saveSettings);
  // 右栏在项目草稿页按 projectId 开面板：此时 sessionId 是项目 id，走 project.* 路由到项目目录 worker
  const isProject = useApp(s => s.registry.projects.some(p => p.id === sessionId));
  const workingDir = useApp(s => (s.registry.sessions.find(x => x.id === sessionId) || s.registry.projects.find(x => x.id === sessionId))?.workingDir || '');
  const mcpStatusUpdate = useApp(s => s.mcpStatusUpdate);
  const [info, setInfo] = useState<ExtensionsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 展开的行：顶层 rule / memory / skills / tools / hooks，嵌套 builtin / mcp:名；默认只展开「工具与 MCP」 */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['tools']));
  const toggleExpand = (key: string) => setExpanded(prev => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
  /** 启停进行中的项（`skill:名` / `mcp:名`）：开关禁用防连点，MCP enable 要等 core 连接完成（冷启动可达数秒） */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const setBusyKey = (key: string, on: boolean) => setBusy(prev => { const next = new Set(prev); on ? next.add(key) : next.delete(key); return next; });

  const call = <T,>(name: ExtAction, payload: Record<string, unknown>) => isProject
    ? wsClient.request<T>(`project.${name}` as WsAction, undefined, { ...payload, projectId: sessionId })
    : wsClient.request<T>(`session.${name}` as WsAction, sessionId, payload);

  /** refresh：全部重扫（含 MCP 按配置重连）；silent：后台重拉不动现有内容（重复打开标签 / MCP 状态变化） */
  const load = async (opts: { refresh?: boolean; silent?: boolean } = {}) => {
    if (opts.refresh) setRefreshing(true); else if (!opts.silent) setLoading(true);
    try { setInfo(await call<ExtensionsInfo>('getExtensionsInfo', { refresh: !!opts.refresh })); setError(null); }
    catch (e: any) {
      const msg = e?.message || String(e);
      if (opts.refresh || opts.silent) toast(`${t('ext.loadFailed')}：${msg}`, 'error'); else setError(msg);
    }
    setRefreshing(false);
    setLoading(false);
  };
  // focusSeq：从加号菜单再次打开会变化，静默重拉
  const loaded = useRef(false);
  useEffect(() => { void load({ silent: loaded.current }); loaded.current = true; }, [sessionId, tab.focusSeq]);
  // MCP 连接状态变化（任一 worker 的 mcp:server:status）：300ms 防抖后静默重拉；挂载首帧由上面的 effect 负责
  const mcpSeq = useRef(mcpStatusUpdate);
  useEffect(() => {
    if (mcpStatusUpdate === mcpSeq.current) return;
    mcpSeq.current = mcpStatusUpdate;
    const timer = window.setTimeout(() => void load({ silent: true }), 300);
    return () => window.clearTimeout(timer);
  }, [mcpStatusUpdate]);

  const toggleSkill = async (skill: ExtSkill, enabled: boolean) => {
    const key = `skill:${skill.name}`;
    setBusyKey(key, true);
    setInfo(i => i && { ...i, skills: i.skills.map(x => x.name === skill.name ? { ...x, enabled } : x) });
    try {
      const skills = await call<ExtSkill[]>('toggleSkill', { name: skill.name, enabled });
      setInfo(i => i && { ...i, skills });
      // 用户级与项目级 disabledSkills 取并集：本层已放开但另一层仍停用时，开关弹回并提示
      if (enabled && skills.find(x => x.name === skill.name)?.enabled === false) toast(t('ext.stillDisabled'), 'warn');
    } catch (e: any) { toast(e?.message || String(e), 'error'); void load({ silent: true }); }
    finally { setBusyKey(key, false); }
  };
  const toggleMcp = async (mcp: ExtMcp, enabled: boolean) => {
    const key = `mcp:${mcp.name}`;
    setBusyKey(key, true);
    setInfo(i => i && { ...i, mcp: i.mcp.map(x => x.name === mcp.name ? { ...x, enabled } : x) });
    try {
      // 响应即权威状态：core 断 / 连完成才返回
      const list = await call<ExtMcp[]>('toggleMcp', { name: mcp.name, enabled });
      setInfo(i => i && { ...i, mcp: list });
      if (enabled && list.find(x => x.name === mcp.name)?.enabled === false) toast(t('ext.stillDisabled'), 'warn');
      if (!enabled) setExpanded(prev => { const next = new Set(prev); next.delete(key); return next; });
    } catch (e: any) { toast(e?.message || String(e), 'error'); void load({ silent: true }); }
    finally { setBusyKey(key, false); }
  };
  /** MCP 单工具开关：useTools null = 全部可用；全部勾上时写回 null（回到缺省态，与 core 语义一致）。乐观更新，失败重拉回滚 */
  const toggleMcpTool = async (mcp: ExtMcp, toolName: string, enabled: boolean) => {
    const all = (mcp.tools || []).map(tool => tool.name);
    const cur = new Set(mcp.useTools == null ? all : mcp.useTools);
    enabled ? cur.add(toolName) : cur.delete(toolName);
    const next = all.every(n => cur.has(n)) ? null : all.filter(n => cur.has(n));
    setInfo(i => i && { ...i, mcp: i.mcp.map(x => x.name === mcp.name ? { ...x, useTools: next } : x) });
    try {
      const list = await call<ExtMcp[]>('updateMcpUseTools', { name: mcp.name, toolNames: next });
      setInfo(i => i && { ...i, mcp: list });
    } catch (e: any) { toast(e?.message || String(e), 'error'); void load({ silent: true }); }
  };
  /** 内置工具开关：改 settings.disabledTools 黑名单（全局生效），服务端落盘后广播到全部 worker。
   * 在已存名单上增删，当前环境不可用（未列出）的工具不会被误放开 */
  const toggleBuiltinTool = async (name: string, enabled: boolean) => {
    const set = new Set(settings?.disabledTools || []);
    enabled ? set.delete(name) : set.add(name);
    setInfo(i => i && { ...i, builtinTools: i.builtinTools.map(x => x.name === name ? { ...x, enabled } : x) });
    try { await saveSettings({ disabledTools: set.size ? [...set] : null }); }
    catch (e: any) { toast(e?.message || String(e), 'error'); void load({ silent: true }); }
  };

  /** core 的 filePath 定位串 "路径:起始行-结束行"（找不到范围时为纯路径） */
  const openLocated = (fp: string) => {
    const m = fp.match(/^(.+):(\d+)-(\d+)$/);
    m ? openFileTab(sessionId, m[1], Number(m[2]), Number(m[3])) : openFileTab(sessionId, fp);
  };

  // 技能 / MCP：已停用的排到最后，其余按项目级在前、同层按名称
  const off = (x: { enabled: boolean }) => x.enabled ? 0 : 1;
  const skills = useMemo(() => [...(info?.skills || [])].sort((a, b) => off(a) - off(b) || scopeRank(a.locate) - scopeRank(b.locate) || a.name.localeCompare(b.name)), [info?.skills]);
  const mcp = useMemo(() => [...(info?.mcp || [])].sort((a, b) => off(a) - off(b) || scopeRank(a.scope) - scopeRank(b.scope) || a.name.localeCompare(b.name)), [info?.mcp]);
  // 命令 / 子代理无开关：内置（仅子代理）→ 项目级 → 用户级 → 插件，同层按名称
  const commands = useMemo(() => [...(info?.commands || [])].sort((a, b) => scopeRank(a.locate) - scopeRank(b.locate) || a.name.localeCompare(b.name)), [info?.commands]);
  const agents = useMemo(() => [...(info?.agents || [])].sort((a, b) => scopeRank(a.locate) - scopeRank(b.locate) || a.name.localeCompare(b.name)), [info?.agents]);
  const builtinTools = info?.builtinTools || [];
  // 钩子：同一来源、同一事件（插件再按插件名）合并成一组。失效的（skipped / invalid）排后面：
  // 组内失效条目沉底；整组都失效的排到所有有效组之后；其余按项目级在前，组内保持 core 给的事件顺序
  const hookGroups = useMemo(() => {
    const groups: HookGroup[] = [];
    for (const h of info?.hooks.entries || []) {
      const key = `${h.source}:${h.pluginName || ''}:${h.event}`;
      const g = groups.find(x => x.key === key);
      g ? g.entries.push(h) : groups.push({ key, event: h.event, source: h.source, pluginName: h.pluginName, entries: [h] });
    }
    const dead = (h: ExtHook) => h.status === 'ok' ? 0 : 1;
    for (const g of groups) g.entries.sort((a, b) => dead(a) - dead(b));
    const allDead = (g: HookGroup) => g.entries.every(e => e.status !== 'ok') ? 1 : 0;
    return groups.sort((a, b) => allDead(a) - allDead(b) || scopeRank(a.source) - scopeRank(b.source));
  }, [info?.hooks]);
  /** 打开 hook 所属配置文件并定位事件块；旧版 core 无 filePath 时退化为整文件打开（插件 hooks 无统一路径，不给入口） */
  const hookFile = (g: HookGroup) => g.entries.find(e => e.filePath)?.filePath
    || (g.source === 'user' && info?.hooks.userConfigExists ? info.hooks.userConfigPath : g.source === 'project' && info?.hooks.projectConfigExists ? info.hooks.projectConfigPath : '');

  const rule = info?.rule;
  const memory = info?.memory;
  const memoryCount = useMemo(() => memory?.prompt ? memoryEntryCount(memory) : 0, [memory]);
  const parseErrors = info?.hooks.parseErrors || [];
  const hooksTotal = info?.hooks.entries.length || 0;
  const toolSources = (builtinTools.length ? 1 : 0) + mcp.length;
  const showContext = !!rule || !!memory?.prompt;
  const showCapability = skills.length > 0 || commands.length > 0 || agents.length > 0 || toolSources > 0;
  const showHooks = hookGroups.length > 0 || parseErrors.length > 0;
  const empty = !showContext && !showCapability && !showHooks;

  return (
    <>
      <div className="h-9 shrink-0 flex items-center gap-1 px-3 border-b border-border">
        <span className="text-xs text-muted truncate" title={workingDir}>{fileName(workingDir)}</span>
        <span className="flex-1" />
        <button onClick={() => void load({ refresh: true })} disabled={refreshing || loading} className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-black/[0.05] disabled:opacity-40" title={t('memory.refresh')}>
          {refreshing ? <Spinner className="h-3.5 w-3.5" /> : <RotateCw size={13} />}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col divide-y divide-border">
        {loading ? (
          <div className="flex-1 flex items-center justify-center"><Spinner /></div>
        ) : !info ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted gap-2 p-6">
            <Puzzle size={30} className="text-fg" />
            <div className="text-xs text-danger break-words">{t('ext.loadFailed')}：{error}</div>
            <button onClick={() => void load()} className="h-7 px-3 rounded-md border border-border hover:bg-black/[0.05] text-fg text-xs">{t('common.retry')}</button>
          </div>
        ) : empty ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted gap-2 p-6">
            <Puzzle size={30} className="text-fg" />
            <div className="max-w-xs text-xs">{t('ext.empty')}</div>
          </div>
        ) : (
          <>
            {showContext && (
              <Region title={t('ext.regionContext')} hint={t('ext.regionContextHint')}>
                {/* 规则：core 只给生效的一份（项目级覆盖用户级）；展开看正文 */}
                {rule && (
                  <Item icon={<FileText size={16} />} label={t('ext.rule')} open={expanded.has('rule')} onToggle={() => toggleExpand('rule')}
                    sub={<><FileName fp={rule.filePath} onOpen={() => openFileTab(sessionId, rule.filePath)} /><span className="mx-1">·</span>{scopeLabel(rule.locate)}</>}>
                    <pre className="mt-1 rounded-lg border border-border px-2.5 py-2 text-xs text-muted whitespace-pre-wrap break-words font-sans leading-relaxed max-h-80 overflow-y-auto">{rule.prompt}</pre>
                  </Item>
                )}
                {/* 记忆：复用记忆标签的条目列表，点条目打开对应文件 */}
                {memory?.prompt && (
                  <Item icon={<Brain size={16} />} label={t('ext.memory')} value={t('ext.items', { n: memoryCount })} open={expanded.has('memory')} onToggle={() => toggleExpand('memory')}
                    sub={memory.FilePath ? <FileName fp={memory.FilePath} onOpen={() => openFileTab(sessionId, memory.FilePath!)} /> : 'MEMORY.md'}>
                    <div className="mt-1 rounded-lg border border-border px-2.5 py-1"><MemoryEntries sessionId={sessionId} memory={memory} compact /></div>
                  </Item>
                )}
              </Region>
            )}

            {showCapability && (
              <Region title={t('ext.regionCapability')} hint={t('ext.regionCapabilityHint')}>
                {/* 技能：点名称打开 SKILL.md；开关写入层由 core 按所在层决定，内置的只读无开关；插件技能显示短名，完整名在 tooltip */}
                {skills.length > 0 && (
                  <Item icon={<Sparkles size={16} />} label={t('ext.skills')} alias="Skills" value={t('ext.items', { n: skills.length })}
                    open={expanded.has('skills')} onToggle={() => toggleExpand('skills')}>
                    {skills.map(s => {
                      const short = (s.locate === 'plugin' && splitPluginName(s.name, 'skill')?.short) || s.name;
                      return (
                        <SubRow key={`${s.locate}:${s.name}`} title={s.name} sub={s.description || undefined} tags={<ScopeTag scope={s.locate} />}
                          label={s.filePath ? <FileName fp={s.filePath} label={short} title={s.name} onOpen={() => openFileTab(sessionId, s.filePath!)} /> : short}
                          toggle={s.locate === 'builtin' ? undefined : <Toggle small checked={s.enabled} disabled={busy.has(`skill:${s.name}`)} onChange={v => toggleSkill(s, v)} />} />
                      );
                    })}
                  </Item>
                )}

                {/* 命令：只读（core 无启停），名称显示成 /name 与斜杠菜单一致，点名称打开命令文件；标题后跟作用域标签；次行描述，有参数提示再加一行 */}
                {commands.length > 0 && (
                  <Item icon={<SquareSlash size={16} />} label={t('ext.commands')} alias="Commands" value={t('ext.items', { n: commands.length })}
                    open={expanded.has('commands')} onToggle={() => toggleExpand('commands')}>
                    {commands.map(c => {
                      const short = `/${(c.locate === 'plugin' && splitPluginName(c.name, 'skill')?.short) || c.name}`;
                      return (
                        <SubRow key={`${c.locate}:${c.name}`} title={`/${c.name}`} tags={<ScopeTag scope={c.locate} />}
                          label={c.filePath ? <FileName fp={c.filePath} label={short} title={`/${c.name}`} onOpen={() => openFileTab(sessionId, c.filePath!)} /> : short}
                          sub={<>
                            {c.description && <div className="truncate" title={c.description}>{c.description}</div>}
                            {c.argumentHint && <div className="truncate font-mono" title={c.argumentHint}>args: {c.argumentHint}</div>}
                          </>} />
                      );
                    })}
                  </Item>
                )}

                {/* 子代理：只读（core 无启停），点名称打开定义文件（内置的无文件）；标题后跟作用域标签，非主模型再加模型标签；次行描述，限定了工具的再加一行 */}
                {agents.length > 0 && (
                  <Item icon={<Bot size={16} />} label={t('ext.agents')} alias="Agents" value={t('ext.items', { n: agents.length })}
                    open={expanded.has('agents')} onToggle={() => toggleExpand('agents')}>
                    {agents.map(a => {
                      const short = (a.locate === 'plugin' && splitPluginName(a.name, 'skill')?.short) || a.name;
                      const tools = a.tools === '*' ? '' : a.tools.join(', ');
                      return (
                        <SubRow key={`${a.locate}:${a.name}`} title={a.name}
                          tags={<>
                            <ScopeTag scope={a.locate} />
                            {a.model && a.model !== 'main' && <span className="text-[10px] font-mono text-muted bg-black/[0.05] px-1.5 py-px rounded shrink-0" title="model">{a.model}</span>}
                          </>}
                          label={a.filePath ? <FileName fp={a.filePath} label={short} title={a.name} onOpen={() => openFileTab(sessionId, a.filePath!)} /> : short}
                          sub={<>
                            {a.description && <div className="truncate" title={a.description}>{a.description}</div>}
                            {tools && <div className="truncate" title={tools}>tools: {tools}</div>}
                          </>} />
                      );
                    })}
                  </Item>
                )}

                {/* 工具与 MCP：内置工具一行（展开分页工具列表）+「MCP 服务」小标题 + 每个 server 一行（展开看配置、错误与工具列表） */}
                {toolSources > 0 && (
                  <Item icon={<Wrench size={16} />} label={t('ext.toolsMcp')} value={t('ext.sources', { n: toolSources })}
                    open={expanded.has('tools')} onToggle={() => toggleExpand('tools')}>
                    {builtinTools.length > 0 && (
                      <SubRow label={t('ext.builtinTools')} sub={countText('ext.unitTools', builtinTools.length, countOn(builtinTools))}
                        open={expanded.has('builtin')} onToggle={() => toggleExpand('builtin')}>
                        <ToolList tools={builtinTools} onToggle={toggleBuiltinTool} />
                      </SubRow>
                    )}
                    {mcp.length > 0 && <Caption>{t('ext.mcpServers')}</Caption>}
                    {mcp.map(m => {
                      const key = `mcp:${m.name}`;
                      const short = (m.scope === 'plugin' && splitPluginName(m.name, 'mcp')?.short) || m.name;
                      const isOn = (toolName: string) => m.useTools == null || m.useTools.includes(toolName);
                      const toolsOn = m.tools ? m.tools.filter(tool => isOn(tool.name)).length : 0;
                      const serverBusy = busy.has(key);
                      const readOnly = m.scope === 'builtin';
                      // 开关表示是否启用，停用不再另写文字；启用的在右侧写连接情况（连接失败要明确写出）。
                      // 已连接是常态，用普通灰字；只有连接中 / 失败这两个需要留意的状态带颜色
                      const [status, statusCls]: [string, string] = m.connectStatus === 'connected' ? [t('eco.connOk'), 'text-muted']
                        : m.connectStatus === 'connecting' ? [t('eco.connConnecting'), 'text-warn']
                        : m.connectStatus === 'error' ? [t('ext.connFailed'), 'text-danger']
                        : [t('eco.connIdle'), 'text-muted'];
                      return (
                        <SubRow key={`${m.scope}:${m.name}`} title={m.name} tags={<ScopeTag scope={m.scope} />}
                          label={m.filePath ? <FileName fp={m.filePath} label={short} title={m.name} onOpen={() => openLocated(m.filePath!)} /> : short}
                          sub={m.enabled && m.tools ? countText('ext.unitTools', m.tools.length, toolsOn) : undefined}
                          status={m.enabled ? status : undefined} statusCls={statusCls} statusTitle={m.connectStatus === 'error' ? m.error : undefined}
                          toggle={readOnly ? undefined : <Toggle small checked={m.enabled} disabled={serverBusy} onChange={v => toggleMcp(m, v)} />}
                          open={expanded.has(key)} onToggle={() => toggleExpand(key)}>
                          {m.summary && <code className="block py-1 break-all font-mono text-[11px] text-muted">{m.summary}</code>}
                          {m.error && <div className="mt-1.5 text-xs text-danger break-words">{m.error}</div>}
                          <div className="mt-1">
                            {!m.enabled ? <div className="text-xs text-muted py-1">{t('eco.connDisabled')}</div>
                              : !m.tools ? <div className="text-xs text-muted py-1">{status}</div>
                              : m.tools.length === 0 ? <div className="text-xs text-muted py-1">{t('eco.toolsEmpty')}</div>
                              : <ToolList tools={m.tools.map(tool => ({ name: tool.name, description: tool.description || '', enabled: isOn(tool.name) }))}
                                  disabled={serverBusy || readOnly} onToggle={(name, v) => toggleMcpTool(m, name, v)} />}
                          </div>
                        </SubRow>
                      );
                    })}
                  </Item>
                )}
              </Region>
            )}

            {showHooks && (
              <Region title={t('ext.regionAutomation')} hint={t('ext.regionAutomationHint')}>
                {/* 钩子：按来源 + 事件分小标题，每条命令一行；解析错误放最前 */}
                <Item icon={<Webhook size={16} />} label={t('ext.hooks')} alias="Hooks" value={t('ext.items', { n: hooksTotal })}
                  open={expanded.has('hooks')} onToggle={() => toggleExpand('hooks')}>
                  {/* 展开区与技能一致：同一来源的同一事件合成一行，事件名当标题（点击打开配置文件并定位），作用域标签跟在标题后；
                      次行列出该事件下每条命令（单行截断，有 matcher 再多一行，timeout 在悬浮提示里），失效的那条命令右侧红字 */}
                  {parseErrors.map((err, i) => (
                    <div key={i} className="py-1.5 text-xs text-danger break-words">
                      {t('ext.hookParseError', { source: `${scopeLabel(err.source)}${err.pluginName ? ` ${err.pluginName}` : ''}`, message: err.message })}
                    </div>
                  ))}
                  {hookGroups.map(g => {
                    const fp = hookFile(g);
                    const title = g.pluginName ? `${g.event} · ${g.pluginName}` : g.event;
                    return (
                      <SubRow key={g.key} title={title} tags={<ScopeTag scope={g.source} />}
                        label={fp ? <FileName fp={fp} label={g.event} title={title} onOpen={() => openLocated(fp)} /> : g.event}
                        sub={g.entries.map((e, i) => (
                          <div key={i} className={cn(i > 0 && 'mt-1')}>
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="flex-1 min-w-0 truncate font-mono" title={[e.command || '-', e.timeout && `timeout: ${e.timeout}s`].filter(Boolean).join('\n')}>{e.command || '-'}</span>
                              {e.status !== 'ok' && <span className="text-danger shrink-0" title={e.statusReason}>{e.status === 'skipped' ? t('ext.hookSkipped') : t('ext.hookInvalid')}</span>}
                            </div>
                            {e.matcher && <div className="truncate" title={e.matcher}>matcher: {e.matcher}</div>}
                          </div>
                        ))} />
                    );
                  })}
                </Item>
              </Region>
            )}
          </>
        )}
      </div>
    </>
  );
}

/** 分区：标题 + 右侧一句说明，本身不折叠；分区之间由父容器的分隔线隔开 */
function Region({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="py-1.5">
      <div className="px-3 py-2 flex items-center">
        <span className="text-[13px] font-semibold text-fg">{title}</span>
        <span className="flex-1" />
        <span className="text-xs text-muted">{hint}</span>
      </div>
      {children}
    </section>
  );
}

/** 顶层行：图标 + 名称（可带英文别名）/ 次行（可含文件跳转）+ 右侧数量 + 折叠箭头；点行展开嵌套内容（与名称左对齐缩进） */
function Item({ icon, label, alias, sub, value, open, onToggle, children }: {
  icon: React.ReactNode; label: string; alias?: string; sub?: React.ReactNode; value?: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <div>
      <div onClick={onToggle} className="px-3 py-2.5 flex items-center gap-3 cursor-pointer select-none hover:bg-black/[0.02]">
        <span className="text-muted shrink-0 inline-flex">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium text-fg truncate">
            {label}{alias && alias !== label && <span className="ml-1.5 font-normal text-muted">{alias}</span>}
          </div>
          {sub && <div className="text-xs text-muted truncate mt-0.5">{sub}</div>}
        </div>
        {value && <span className="text-xs text-muted shrink-0">{value}</span>}
        <Caret open={open} size={14} className="text-dim" />
      </div>
      {open && <div className="pl-[46px] pr-3 pb-2">{children}</div>}
    </div>
  );
}

/** 嵌套行：名称（+ 作用域标签）/ 次行 + 右侧状态文字、开关；传了 onToggle 的行可点击展开（children），末尾带折叠箭头 */
function SubRow({ label, title, tags, sub, status, statusCls, statusTitle, toggle, open, onToggle, children }: {
  label: React.ReactNode; title?: string; tags?: React.ReactNode; sub?: React.ReactNode; status?: string; statusCls?: string; statusTitle?: string;
  toggle?: React.ReactNode; open?: boolean; onToggle?: () => void; children?: React.ReactNode;
}) {
  return (
    <div>
      <div onClick={onToggle} className={cn('py-2 flex items-center gap-3 min-w-0', onToggle && 'cursor-pointer select-none')}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13px] text-fg truncate" title={title}>{label}</span>
            {tags}
          </div>
          {/* 字符串次行单行截断；节点次行由调用方自己排（可多行，每行自带 truncate） */}
          {sub && <div className="text-xs text-muted mt-0.5 min-w-0">{typeof sub === 'string' ? <div className="truncate" title={sub}>{sub}</div> : sub}</div>}
        </div>
        {status && <span className={cn('text-xs shrink-0', statusCls || 'text-muted')} title={statusTitle}>{status}</span>}
        {toggle && <span onClick={e => e.stopPropagation()} className="shrink-0 inline-flex">{toggle}</span>}
        {onToggle && <Caret open={!!open} size={14} className="text-dim" />}
      </div>
      {open && children && <div className="mb-2">{children}</div>}
    </div>
  );
}

/** 作用域标签：项目级 / 用户级 / 插件 */
function ScopeTag({ scope }: { scope: string }) {
  return <span className="text-[10px] text-muted bg-black/[0.05] px-1.5 py-px rounded shrink-0">{scopeLabel(scope)}</span>;
}
/** 嵌套区里的小标题（如「MCP 服务」、钩子的事件名），右侧可放操作 */
function Caption({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="pt-2 pb-1 flex items-center gap-2">
      <span className="flex-1 min-w-0 truncate text-[11px] text-muted">{children}</span>
      {action}
    </div>
  );
}

/** 行里可点击跳转文件的名字（默认显示文件名，也可显示技能 / MCP 名），不触发所在行的展开 */
function FileName({ fp, label, title, onOpen }: { fp: string; label?: string; title?: string; onOpen: () => void }) {
  return <button onClick={e => { e.stopPropagation(); onOpen(); }} className="truncate hover:underline hover:text-accent" title={title || fp}>{label || fileName(fp)}</button>;
}

/** 工具列表：每行 名称 / 描述 + 开关，停用的只靠开关表示不置灰；列表行左侧一条竖线并缩进一级（翻页控件不在线内）；
 * 超过一页时底部翻页（条数变化用 clamp 兜底，不需要重置页码） */
function ToolList({ tools, disabled, onToggle }: { tools: ExtTool[]; disabled?: boolean; onToggle: (name: string, enabled: boolean) => void }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(tools.length / TOOLS_PAGE_SIZE));
  const cur = Math.min(page, totalPages);
  const paged = tools.slice((cur - 1) * TOOLS_PAGE_SIZE, cur * TOOLS_PAGE_SIZE);
  const pageBtn = 'p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06] disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <>
      <div className="ml-1 border-l border-border pl-3">
        {paged.map(tool => (
          <div key={tool.name} className="flex items-center gap-3 py-1.5 min-w-0">
            <div className="flex-1 min-w-0">
              <div className="text-xs text-fg truncate" title={tool.name}>{tool.name}</div>
              {tool.description && <div className="text-[11px] text-muted truncate" title={tool.description}>{tool.description}</div>}
            </div>
            <Toggle small checked={tool.enabled} disabled={disabled} onChange={v => onToggle(tool.name, v)} />
          </div>
        ))}
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 py-1">
          <button onClick={() => setPage(Math.max(1, cur - 1))} disabled={cur === 1} className={pageBtn}><ChevronLeft size={14} /></button>
          <span className="text-xs text-muted">{cur} / {totalPages}</span>
          <button onClick={() => setPage(Math.min(totalPages, cur + 1))} disabled={cur === totalPages} className={pageBtn}><ChevronRight size={14} /></button>
        </div>
      )}
    </>
  );
}

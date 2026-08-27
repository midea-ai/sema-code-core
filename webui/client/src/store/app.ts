/** 应用级 store：注册表 / 设置 / 视图 / 模型数据 / 右侧标签 / toast */
import { create } from 'zustand';
import { api } from '../api/http';
import { wsClient, type WsStatus } from '../api/ws';
import type { Registry, WebUISettings, ProjectRecord, SessionRecord } from '../../../shared/types';
import { SERVER_EVENTS } from '../../../shared/protocol';
import { isPrivateUrl, normalizeUrl } from '../common/url';


export type View =
  | { type: 'empty' }
  /** 新会话草稿页：首次发送时才真正创建会话记录 */
  | { type: 'draft'; projectId?: string }
  | { type: 'chat'; sessionId: string }
  | { type: 'settings'; tab: 'models' | 'system' }
  /** 日程：全局定时任务视图 */
  | { type: 'schedule' }
  /** 生态市场：内置技能 / MCP 资源，一键安装到用户级 */
  | { type: 'eco' };

export interface ModelData { modelName: string; modelList: string[]; taskConfig: { main: string; quick: string } }

export interface PanelTab {
  id: string; type: 'browser' | 'files' | 'review' | 'terminal' | 'agent' | 'cron' | 'quickchat' | 'memory'; url?: string; title?: string; history: string[]; index: number;
  /** browser：页面声明的图标地址（服务端解析），导航时清空 */
  icon?: string;
  /** review：定位到的 file-changes 块 id（空=最新一轮）；agent：子代理块 id */
  blockId?: string;
  /** review：定位并展开的单个文件路径（focusSeq 变化时重新定位） */
  focusPath?: string;
  focusSeq?: number;
  /** files：相对 workingDir 的文件路径 */
  path?: string;
  /** terminal：服务端 pty id（刷新后复用回放缓冲） */
  termId?: string;
  /** files：打开后定位/高亮的行范围（lineSeq 变化时重新定位） */
  line?: number;
  endLine?: number;
  lineSeq?: number;
  /** cron：定位并展开的任务 id（focusSeq 变化时重新定位） */
  focusId?: string;
}
export interface PanelState { tabs: PanelTab[]; activeId?: string; collapsed: boolean }

export interface Toast { id: number; level: 'info' | 'error' | 'warn'; text: string }

interface AppState {
  ready: boolean;
  platform: string;
  registry: Registry;
  settings: WebUISettings | null;
  status: Record<string, { state: string; pending: number }>;
  /** 存活会话集合（core worker 进程活着且会话已在其中创建），侧栏图标亮/灰用 */
  liveSessions: Record<string, true>;
  view: View;
  modelData: ModelData | null;
  panels: Record<string, PanelState>;
  toasts: Toast[];
  wsStatus: WsStatus;
  sidebarCollapsed: boolean;
  /** 各项目目录的定时任务变更计数（收到 cron:update 自增），定时任务标签据此重拉列表 */
  cronUpdates: Record<string, number>;
  /** MCP 连接状态变更计数（任一 worker 的 mcp:server:status 自增），生态页据此重拉实时状态，替代轮询 */
  mcpStatusUpdate: number;
  /** 后台完成未读：会话在非当前查看时从处理中转为空闲（侧栏绿灯），点开会话即清除 */
  doneUnread: Record<string, true>;

  bootstrap(): Promise<void>;
  setView(v: View): void;
  markDoneUnread(sessionId: string): void;
  refreshModelData(): Promise<void>;
  toast(text: string, level?: Toast['level']): void;
  dismissToast(id: number): void;
  setSidebarCollapsed(v: boolean): void;

  // 注册表操作
  createProject(name: string): Promise<ProjectRecord>;
  importProject(path: string, name?: string): Promise<ProjectRecord>;
  renameProject(id: string, name: string): Promise<void>;
  removeProject(id: string, deleteFiles?: boolean): Promise<void>;
  revealProject(id: string): Promise<void>;
  createSession(projectId?: string): Promise<SessionRecord>;
  renameSession(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  revealSession(id: string): Promise<void>;
  saveSettings(patch: Partial<WebUISettings>): Promise<void>;
  openExternal(url: string): Promise<void>;

  // 右侧面板
  panelFor(sessionId: string): PanelState;
  openBrowserTab(sessionId: string, url: string, reuse?: boolean): void;
  /** 打开/复用本会话唯一的「审阅」标签，并定位到指定 file-changes 块 */
  openReviewTab(sessionId: string, blockId?: string, focusPath?: string): void;
  /** 打开子代理详情标签：每个 agent 块各占一个标签（按 blockId 复用），标签名用子代理标题 */
  openAgentTab(sessionId: string, blockId: string, title?: string): void;
  /** 打开/复用本会话唯一的「定时任务」标签，可选定位到指定任务 */
  openCronTab(sessionId: string, focusId?: string): void;
  /** 打开/复用本会话唯一的「快问」标签（/quickchat 旁路问答） */
  openQuickchatTab(sessionId: string): void;
  /** 打开/复用本会话唯一的「记忆」标签（.sema/memory/ 记忆文件），每次打开触发刷新 */
  openMemoryTab(sessionId: string): void;
  revealFile(sessionId: string, relPath: string): Promise<void>;
  /** 用系统默认程序打开；app 为 macOS 应用 bundle 路径时用指定应用打开 */
  openFileExternal(sessionId: string, relPath: string, app?: string): Promise<void>;
  /** 在右侧栏打开文件（同路径标签已存在则激活），可选定位行范围 */
  openFileTab(sessionId: string, relPath: string, line?: number, endLine?: number): void;
  /** 聊天里点文件引用：html 在右栏浏览器预览（指定行号时仍看源码），其他类型打开文件标签 */
  openFileRef(sessionId: string, relPath: string, line?: number, endLine?: number): void;
  /** 打开链接：本地文件/本机/局域网地址右栏内嵌；其他地址系统浏览器 */
  openLink(sessionId: string, url: string): Promise<void>;
  updatePanel(sessionId: string, fn: (p: PanelState) => PanelState): void;
}

const PANEL_KEY = 'sema.webui.panels';
const VIEW_KEY = 'sema.webui.view';
const emptyPanel = (): PanelState => ({ tabs: [], collapsed: true }); // 新会话右侧栏默认收起，打开标签时自动展开

function loadPanels(): Record<string, PanelState> {
  try { return JSON.parse(localStorage.getItem(PANEL_KEY) || '{}'); } catch { return {}; }
}
function loadView(): View {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '');
    return v && (v.type === 'chat' || v.type === 'draft' || v.type === 'schedule' || v.type === 'eco') ? v : { type: 'draft' };
  } catch { return { type: 'draft' }; }
}

let toastSeq = 0;

const toLiveMap = (ids?: string[]): Record<string, true> =>
  Object.fromEntries((ids || []).map(id => [id, true as const]));

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  platform: '',
  registry: { schemaVersion: 1, projects: [], sessions: [] },
  settings: null,
  status: {},
  liveSessions: {},
  view: loadView(),
  modelData: null,
  panels: loadPanels(),
  toasts: [],
  wsStatus: 'closed',
  sidebarCollapsed: false,
  cronUpdates: {},
  mcpStatusUpdate: 0,
  doneUnread: {},

  async bootstrap() {
    const data = await api<{ registry: Registry; settings: WebUISettings; status: any; liveSessions?: string[]; platform: string }>('GET', '/api/bootstrap');
    set({ registry: data.registry, settings: data.settings, status: data.status, liveSessions: toLiveMap(data.liveSessions), platform: data.platform, ready: true });
    // 恢复视图：会话已不存在则回到空
    const v = get().view;
    if (v.type === 'chat' && !data.registry.sessions.some(s => s.id === v.sessionId)) set({ view: { type: 'draft' } });
    if (v.type === 'draft' && v.projectId && !data.registry.projects.some(p => p.id === v.projectId)) set({ view: { type: 'draft' } });

    wsClient.onStatus(s => set({ wsStatus: s }));
    wsClient.onFrame(frame => {
      if ('sessionId' in frame && frame.sessionId) return; // 会话事件由 sessions store 处理
      if (frame.event === SERVER_EVENTS.registryUpdate) set({ registry: frame.data });
      else if (frame.event === SERVER_EVENTS.modelUpdate) set({ modelData: frame.data });
      else if (frame.event === SERVER_EVENTS.livenessUpdate) set({ liveSessions: toLiveMap(frame.data?.sessions) });
      else if (frame.event === 'cron:update') {
        const dir = (frame as any).workingDir || '';
        set(s => ({ cronUpdates: { ...s.cronUpdates, [dir]: (s.cronUpdates[dir] || 0) + 1 } }));
      }
      else if (frame.event === 'mcp:server:status') set(s => ({ mcpStatusUpdate: s.mcpStatusUpdate + 1 }));
    });
    wsClient.onOpen(() => {
      const tryLoad = (n: number) => get().refreshModelData().catch(e => {
        if (n > 0) setTimeout(() => tryLoad(n - 1), 2000);
        else get().toast(`模型配置加载失败：${e.message}`, 'error');
      });
      tryLoad(2);
    });
    wsClient.connect();
  },

  setView(v) {
    // 配置页是临时进入的，刷新或下次启动不应停留；其余视图（会话/草稿/日程/生态）刷新后留在原页面
    if (v.type !== 'settings') localStorage.setItem(VIEW_KEY, JSON.stringify(v));
    set({ view: v });
    // 打开会话即视为已阅，清除「后台完成」绿灯
    if (v.type === 'chat' && get().doneUnread[v.sessionId]) {
      const sid = v.sessionId;
      set(s => { const { [sid]: _, ...rest } = s.doneUnread; return { doneUnread: rest }; });
    }
  },
  markDoneUnread(sessionId) {
    set(s => (s.doneUnread[sessionId] ? s : { doneUnread: { ...s.doneUnread, [sessionId]: true } }));
  },

  async refreshModelData() {
    const md = await wsClient.request<ModelData>('core.getModelData');
    set({ modelData: md });
  },

  toast(text, level = 'info') {
    const id = ++toastSeq;
    set(s => ({ toasts: [...s.toasts, { id, level, text }] }));
    setTimeout(() => get().dismissToast(id), level === 'error' ? 8000 : 4000);
  },
  dismissToast(id) { set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })); },
  setSidebarCollapsed(v) { set({ sidebarCollapsed: v }); },

  async createProject(name) { return api('POST', '/api/projects', { name }); },
  async importProject(path, name) { return api('POST', '/api/projects', { importPath: path, name: name || undefined }); },
  async renameProject(id, name) { await api('PATCH', `/api/projects/${id}`, { name }); },
  async removeProject(id, deleteFiles) {
    await api('DELETE', `/api/projects/${id}${deleteFiles ? '?deleteFiles=1' : ''}`);
    const v = get().view;
    if (v.type === 'chat' && !get().registry.sessions.some(s => s.id === v.sessionId)) get().setView({ type: 'draft' });
    if (v.type === 'draft' && v.projectId === id) get().setView({ type: 'draft' });
  },
  async revealProject(id) { await api('POST', `/api/projects/${id}/reveal`); },
  async createSession(projectId) {
    const r = await api<{ record: SessionRecord }>('POST', '/api/sessions', { projectId });
    // 项目草稿页开的面板标签（终端/文件等）随首次发送迁移到新会话
    if (projectId && get().panels[projectId]) {
      set(s => {
        const { [projectId]: draftPanel, ...rest } = s.panels;
        const panels = { ...rest, [r.record.id]: draftPanel };
        localStorage.setItem(PANEL_KEY, JSON.stringify(panels));
        return { panels };
      });
    }
    return r.record;
  },
  async renameSession(id, title) { await api('PATCH', `/api/sessions/${id}`, { title }); },
  async deleteSession(id) {
    await api('DELETE', `/api/sessions/${id}`);
    const v = get().view;
    if (v.type === 'chat' && v.sessionId === id) get().setView({ type: 'draft' });
  },
  async revealSession(id) { await api('POST', `/api/sessions/${id}/reveal`); },
  async revealFile(sessionId, relPath) { await api('POST', `/api/sessions/${sessionId}/reveal-file`, { path: relPath }); },
  async openFileExternal(sessionId, relPath, app) { await api('POST', `/api/sessions/${sessionId}/open-file`, { path: relPath, app }); },
  openFileTab(sessionId, relPath, line, endLine) {
    // 会话目录内的绝对路径转为相对路径展示（面包屑/标题/文件树定位都按相对路径工作）
    const rec = get().registry.sessions.find(x => x.id === sessionId) || get().registry.projects.find(x => x.id === sessionId);
    const wd = (rec?.workingDir || '').replace(/[\\/]+$/, '');
    if (wd && (relPath.startsWith(wd + '/') || relPath.startsWith(wd + '\\'))) relPath = relPath.slice(wd.length + 1);
    get().updatePanel(sessionId, p => {
      const loc = line ? { line, endLine, lineSeq: Date.now() } : {};
      const exist = p.tabs.find(t => t.type === 'files' && t.path === relPath);
      if (exist) return { ...p, collapsed: false, activeId: exist.id, tabs: p.tabs.map(t => t.id === exist.id ? { ...t, ...loc } : t) };
      const tab: PanelTab = { id: `f${Date.now()}`, type: 'files', path: relPath, title: relPath.split(/[\\/]/).pop(), history: [], index: -1, ...loc };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
  openFileRef(sessionId, relPath, line, endLine) {
    if (!line && /\.html?$/i.test(relPath)) {
      const rec = get().registry.sessions.find(x => x.id === sessionId) || get().registry.projects.find(x => x.id === sessionId);
      const abs = /^(\/|[a-zA-Z]:[\\/])/.test(relPath) ? relPath : `${rec?.workingDir || ''}/${relPath}`;
      get().openBrowserTab(sessionId, normalizeUrl(abs));
      return;
    }
    get().openFileTab(sessionId, relPath, line, endLine);
  },
  async openLink(sessionId, url) {
    // 本地文件 / 本机 / 局域网地址右栏内嵌预览；其他一律系统浏览器（不做可嵌探测：有延迟、行为不可预期，且右栏定位是本地预览）
    if (url.startsWith('file://') || isPrivateUrl(url)) { get().openBrowserTab(sessionId, url); return; }
    await get().openExternal(url).catch(() => { window.open(url, '_blank', 'noopener'); });
  },
  async saveSettings(patch) {
    const s = await api<WebUISettings>('PUT', '/api/settings', patch);
    set({ settings: s });
  },
  async openExternal(url) { await api('POST', '/api/open-external', { url }); },

  panelFor(sessionId) { return get().panels[sessionId] || emptyPanel(); },
  updatePanel(sessionId, fn) {
    set(s => {
      const panels = { ...s.panels, [sessionId]: fn(s.panels[sessionId] || emptyPanel()) };
      localStorage.setItem(PANEL_KEY, JSON.stringify(panels));
      return { panels };
    });
  },
  openBrowserTab(sessionId, url, reuse = true) {
    get().updatePanel(sessionId, p => {
      // 同一来源（协议+host+端口）复用已有浏览器标签并在其中导航；不同站点开新标签
      // file:// 的 origin 恒为 "null"，按完整地址区分：同一文件复用，不同文件各开新标签
      const origin = (u?: string) => { try { if (!u) return ''; const p = new URL(u); return p.protocol === 'file:' ? p.href : p.origin; } catch { return ''; } };
      const same = reuse ? p.tabs.find(t => t.type === 'browser' && t.url && origin(t.url) === origin(url)) : undefined;
      if (same) {
        if (same.url === url) return { ...p, collapsed: false, activeId: same.id };
        const history = [...same.history.slice(0, same.index + 1), url];
        const tab = { ...same, url, title: undefined, icon: undefined, history, index: history.length - 1 };
        return { ...p, collapsed: false, activeId: tab.id, tabs: p.tabs.map(t => t.id === tab.id ? tab : t) };
      }
      const tab: PanelTab = { id: `b${Date.now()}`, type: 'browser', url, history: [url], index: 0 };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
  openReviewTab(sessionId, blockId, focusPath) {
    get().updatePanel(sessionId, p => {
      const exist = p.tabs.find(t => t.type === 'review');
      const focus = focusPath ? { focusPath, focusSeq: Date.now() } : {};
      if (exist) {
        const tab = { ...exist, blockId: blockId ?? exist.blockId, ...focus };
        return { ...p, collapsed: false, tabs: p.tabs.map(t => t.id === tab.id ? tab : t), activeId: tab.id };
      }
      const tab: PanelTab = { id: `r${Date.now()}`, type: 'review', history: [], index: -1, blockId, ...focus };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
  openAgentTab(sessionId, blockId, title) {
    get().updatePanel(sessionId, p => {
      const exist = p.tabs.find(t => t.type === 'agent' && t.blockId === blockId);
      if (exist) {
        const tab = { ...exist, title: title ?? exist.title };
        return { ...p, collapsed: false, tabs: p.tabs.map(t => t.id === tab.id ? tab : t), activeId: tab.id };
      }
      const tab: PanelTab = { id: `a${Date.now()}`, type: 'agent', history: [], index: -1, blockId, title };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
  openCronTab(sessionId, focusId) {
    get().updatePanel(sessionId, p => {
      const exist = p.tabs.find(t => t.type === 'cron');
      const focus = focusId ? { focusId, focusSeq: Date.now() } : {};
      if (exist) {
        const tab = { ...exist, ...focus };
        return { ...p, collapsed: false, tabs: p.tabs.map(t => t.id === tab.id ? tab : t), activeId: tab.id };
      }
      const tab: PanelTab = { id: `c${Date.now()}`, type: 'cron', history: [], index: -1, ...focus };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
  openQuickchatTab(sessionId) {
    get().updatePanel(sessionId, p => {
      const exist = p.tabs.find(t => t.type === 'quickchat');
      if (exist) return { ...p, collapsed: false, activeId: exist.id };
      const tab: PanelTab = { id: `q${Date.now()}`, type: 'quickchat', history: [], index: -1 };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
  openMemoryTab(sessionId) {
    get().updatePanel(sessionId, p => {
      const exist = p.tabs.find(t => t.type === 'memory');
      if (exist) {
        // focusSeq 变化触发记忆标签重新加载（记忆刚被本轮修改过）
        const tab = { ...exist, focusSeq: Date.now() };
        return { ...p, collapsed: false, tabs: p.tabs.map(t => t.id === tab.id ? tab : t), activeId: tab.id };
      }
      const tab: PanelTab = { id: `m${Date.now()}`, type: 'memory', history: [], index: -1 };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
}));

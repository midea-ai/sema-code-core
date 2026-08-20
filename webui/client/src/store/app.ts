/** 应用级 store：注册表 / 设置 / 视图 / 模型数据 / 右侧标签 / toast */
import { create } from 'zustand';
import { api } from '../api/http';
import { wsClient, type WsStatus } from '../api/ws';
import type { Registry, WebUISettings, ProjectRecord, SessionRecord } from '../../../shared/types';
import { SERVER_EVENTS } from '../../../shared/protocol';
import { isPrivateUrl } from '../common/url';

/** URL 可嵌入探测结果缓存（会话期内有效） */
const probeCache = new Map<string, boolean>();

export type View =
  | { type: 'empty' }
  /** 新会话草稿页：首次发送时才真正创建会话记录 */
  | { type: 'draft'; projectId?: string }
  | { type: 'chat'; sessionId: string }
  | { type: 'settings'; tab: 'models' | 'system' };

export interface ModelData { modelName: string; modelList: string[]; taskConfig: { main: string; quick: string } }

export interface PanelTab {
  id: string; type: 'browser' | 'files' | 'review' | 'terminal' | 'agent'; url?: string; title?: string; history: string[]; index: number;
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
}
export interface PanelState { tabs: PanelTab[]; activeId?: string; collapsed: boolean }

export interface Toast { id: number; level: 'info' | 'error' | 'warn'; text: string }

interface AppState {
  ready: boolean;
  platform: string;
  registry: Registry;
  settings: WebUISettings | null;
  status: Record<string, { state: string; pending: number }>;
  view: View;
  modelData: ModelData | null;
  panels: Record<string, PanelState>;
  toasts: Toast[];
  wsStatus: WsStatus;
  sidebarCollapsed: boolean;

  bootstrap(): Promise<void>;
  setView(v: View): void;
  refreshModelData(): Promise<void>;
  toast(text: string, level?: Toast['level']): void;
  dismissToast(id: number): void;
  setSidebarCollapsed(v: boolean): void;

  // 注册表操作
  createProject(name: string): Promise<ProjectRecord>;
  importProject(path: string, name?: string): Promise<ProjectRecord>;
  renameProject(id: string, name: string): Promise<void>;
  removeProject(id: string): Promise<void>;
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
  /** 打开/复用本会话唯一的「子智能体」标签，并定位到指定 agent 块 */
  openAgentTab(sessionId: string, blockId: string): void;
  revealFile(sessionId: string, relPath: string): Promise<void>;
  /** 用系统默认程序打开；app 为 macOS 应用 bundle 路径时用指定应用打开 */
  openFileExternal(sessionId: string, relPath: string, app?: string): Promise<void>;
  /** 在右侧栏打开文件（同路径标签已存在则激活），可选定位行范围 */
  openFileTab(sessionId: string, relPath: string, line?: number, endLine?: number): void;
  /** 打开链接：本机/局域网地址直接右栏内嵌；其他地址经服务端探测，可嵌则右栏，否则系统浏览器 */
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
    return v && (v.type === 'chat' || v.type === 'draft') ? v : { type: 'draft' };
  } catch { return { type: 'draft' }; }
}

let toastSeq = 0;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  platform: '',
  registry: { schemaVersion: 1, projects: [], sessions: [] },
  settings: null,
  status: {},
  view: loadView(),
  modelData: null,
  panels: loadPanels(),
  toasts: [],
  wsStatus: 'closed',
  sidebarCollapsed: false,

  async bootstrap() {
    const data = await api<{ registry: Registry; settings: WebUISettings; status: any; platform: string }>('GET', '/api/bootstrap');
    set({ registry: data.registry, settings: data.settings, status: data.status, platform: data.platform, ready: true });
    // 恢复视图：会话已不存在则回到空
    const v = get().view;
    if (v.type === 'chat' && !data.registry.sessions.some(s => s.id === v.sessionId)) set({ view: { type: 'draft' } });
    if (v.type === 'draft' && v.projectId && !data.registry.projects.some(p => p.id === v.projectId)) set({ view: { type: 'draft' } });

    wsClient.onStatus(s => set({ wsStatus: s }));
    wsClient.onFrame(frame => {
      if ('sessionId' in frame && frame.sessionId) return; // 会话事件由 sessions store 处理
      if (frame.event === SERVER_EVENTS.registryUpdate) set({ registry: frame.data });
      else if (frame.event === SERVER_EVENTS.modelUpdate) set({ modelData: frame.data });
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
    // 只持久化会话/空白视图：配置页是临时进入的，刷新或下次启动不应停留在配置页
    if (v.type !== 'settings') localStorage.setItem(VIEW_KEY, JSON.stringify(v));
    set({ view: v });
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
  async removeProject(id) {
    await api('DELETE', `/api/projects/${id}`);
    const v = get().view;
    if (v.type === 'chat' && !get().registry.sessions.some(s => s.id === v.sessionId)) get().setView({ type: 'draft' });
    if (v.type === 'draft' && v.projectId === id) get().setView({ type: 'draft' });
  },
  async revealProject(id) { await api('POST', `/api/projects/${id}/reveal`); },
  async createSession(projectId) {
    const r = await api<{ record: SessionRecord }>('POST', '/api/sessions', { projectId });
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
    get().updatePanel(sessionId, p => {
      const loc = line ? { line, endLine, lineSeq: Date.now() } : {};
      const exist = p.tabs.find(t => t.type === 'files' && t.path === relPath);
      if (exist) return { ...p, collapsed: false, activeId: exist.id, tabs: p.tabs.map(t => t.id === exist.id ? { ...t, ...loc } : t) };
      const tab: PanelTab = { id: `f${Date.now()}`, type: 'files', path: relPath, title: relPath.split(/[\\/]/).pop(), history: [], index: -1, ...loc };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
  async openLink(sessionId, url) {
    const external = () => get().openExternal(url).catch(() => { window.open(url, '_blank', 'noopener'); });
    if (isPrivateUrl(url)) { get().openBrowserTab(sessionId, url); return; }
    const key = `probe:${url}`;
    let embeddable = probeCache.get(key);
    if (embeddable === undefined) {
      try { embeddable = (await api<{ embeddable: boolean }>('POST', '/api/probe-url', { url })).embeddable; } catch { embeddable = false; }
      probeCache.set(key, embeddable);
    }
    if (embeddable) get().openBrowserTab(sessionId, url); else await external();
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
      const origin = (u?: string) => { try { return u ? new URL(u).origin : ''; } catch { return ''; } };
      const same = reuse ? p.tabs.find(t => t.type === 'browser' && t.url && origin(t.url) === origin(url)) : undefined;
      if (same) {
        if (same.url === url) return { ...p, collapsed: false, activeId: same.id };
        const history = [...same.history.slice(0, same.index + 1), url];
        const tab = { ...same, url, history, index: history.length - 1 };
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
  openAgentTab(sessionId, blockId) {
    get().updatePanel(sessionId, p => {
      const exist = p.tabs.find(t => t.type === 'agent');
      if (exist) {
        const tab = { ...exist, blockId };
        return { ...p, collapsed: false, tabs: p.tabs.map(t => t.id === tab.id ? tab : t), activeId: tab.id };
      }
      const tab: PanelTab = { id: `a${Date.now()}`, type: 'agent', history: [], index: -1, blockId };
      return { ...p, collapsed: false, tabs: [...p.tabs, tab], activeId: tab.id };
    });
  },
}));

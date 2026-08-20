/** 会话 store：快照缓存 / 订阅 / 事件应用（与服务端共用 reducer）/ 会话动作 */
import { create } from 'zustand';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import type { SessionSnapshot, AgentMode, PermissionLevel, EventFrame } from '../../../shared/types';
import { applyEvent, applyLocal, LocalAction } from '../../../shared/transcript';
import { SERVER_EVENTS } from '../../../shared/protocol';
import { useApp } from './app';

interface Draft { text: string; images: { dataUrl: string; media_type: string; data: string }[] }

interface SessionsState {
  snapshots: Record<string, SessionSnapshot>;
  loading: Record<string, boolean>;
  subscribed: Set<string>;
  drafts: Record<string, Draft>;
  /** 会话级临时错误提示 */
  errors: Record<string, string | undefined>;

  open(sessionId: string): Promise<void>;
  warm(sessionId: string): void;
  loadSnapshot(sessionId: string): Promise<void>;
  applyFrame(frame: EventFrame): void;
  local(sessionId: string, action: LocalAction): void;
  setDraft(sessionId: string, fn: (d: Draft) => Draft): void;

  send(sessionId: string, text: string, images?: Draft['images']): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respondPermission(sessionId: string, toolId: string, toolName: string, selected: string): Promise<void>;
  respondPick(sessionId: string, blockId: string, agentId: string, answers: string | null): Promise<void>;
  respondPlanExit(sessionId: string, blockId: string, agentId: string, selected: string): Promise<void>;
  setAgentMode(sessionId: string, mode: AgentMode): Promise<void>;
  setPermissionLevel(sessionId: string, level: PermissionLevel): Promise<void>;
  getForkPreview(sessionId: string, messageUuid: string): Promise<any>;
  fork(sessionId: string, messageUuid: string, restoreFiles: boolean): Promise<any>;
}

const emptyDraft = (): Draft => ({ text: '', images: [] });
let wired = false;

export const useSessions = create<SessionsState>((set, get) => ({
  snapshots: {},
  loading: {},
  subscribed: new Set(),
  drafts: {},
  errors: {},

  async open(sessionId) {
    if (!wired) {
      wired = true;
      wsClient.onFrame(frame => {
        if ('sessionId' in frame && frame.sessionId && typeof (frame as any).seq === 'number') get().applyFrame(frame as EventFrame);
        else if (frame.event === SERVER_EVENTS.sessionResync && frame.data?.sessionId) get().loadSnapshot(frame.data.sessionId).catch(() => undefined);
      });
      // 重连后重新订阅全部浏览过的会话（带 afterSeq 补发）；只预热当前正在看的那个
      wsClient.onOpen(() => {
        const view = useApp.getState().view;
        for (const id of get().subscribed) {
          get().loadSnapshot(id).then(() => { if (view.type === 'chat' && view.sessionId === id) get().warm(id); }).catch(() => undefined);
        }
      });
    }
    set(s => ({ subscribed: new Set(s.subscribed).add(sessionId) }));
    await get().loadSnapshot(sessionId);
    get().warm(sessionId);
  },

  /** 预热：拉起该会话目录的 core worker（只在打开会话时调用，失败不影响 UI） */
  warm(sessionId) {
    if (wsClient.status !== 'open') return;
    wsClient.request('session.warm', sessionId, {}).catch(e => console.warn('[session] warm failed', e?.message));
  },

  /** 取快照 → 订阅(afterSeq) → 缓冲不足则再取一次 */
  async loadSnapshot(sessionId) {
    set(s => ({ loading: { ...s.loading, [sessionId]: true } }));
    try {
      const snap = await api<SessionSnapshot>('GET', `/api/sessions/${sessionId}/snapshot`);
      set(s => ({ snapshots: { ...s.snapshots, [sessionId]: snap } }));
      if (wsClient.status !== 'open') return;
      const r = await wsClient.request<{ seq: number; resync: boolean }>('session.subscribe', sessionId, { afterSeq: snap.seq });
      if (r?.resync) {
        const again = await api<SessionSnapshot>('GET', `/api/sessions/${sessionId}/snapshot`);
        set(s => ({ snapshots: { ...s.snapshots, [sessionId]: again } }));
      }
    } finally {
      set(s => ({ loading: { ...s.loading, [sessionId]: false } }));
    }
  },

  applyFrame(frame) {
    const cur = get().snapshots[frame.sessionId];
    if (!cur) return;
    if (frame.seq <= cur.seq) return; // 重放/重复
    if (frame.seq > cur.seq + 1) {
      // 漏帧：回退到重新拉快照
      get().loadSnapshot(frame.sessionId).catch(() => undefined);
      return;
    }
    const next = applyEvent({ ...cur }, frame.event, frame.data, frame.seq);
    set(s => ({ snapshots: { ...s.snapshots, [frame.sessionId]: next } }));
    if (frame.event === 'session:error') {
      useApp.getState().toast(frame.data?.error?.message || '会话出错', 'error');
    }
  },

  local(sessionId, action) {
    const cur = get().snapshots[sessionId];
    if (!cur) return;
    set(s => ({ snapshots: { ...s.snapshots, [sessionId]: applyLocal({ ...cur }, action) } }));
  },

  setDraft(sessionId, fn) {
    set(s => ({ drafts: { ...s.drafts, [sessionId]: fn(s.drafts[sessionId] || emptyDraft()) } }));
  },

  async send(sessionId, text, images = []) {
    const attachments = images.map(i => ({ type: 'image', data: i.data, media_type: i.media_type }));
    await wsClient.request('session.processUserInput', sessionId, { input: text, attachments: attachments.length ? attachments : undefined });
    get().setDraft(sessionId, () => emptyDraft());
  },
  async interrupt(sessionId) { await wsClient.request('session.interrupt', sessionId, {}); },
  async respondPermission(sessionId, toolId, toolName, selected) {
    get().local(sessionId, { type: 'permission', toolId, selected });
    await wsClient.request('session.respondToToolPermission', sessionId, { response: { toolId, toolName, selected } });
  },
  async respondPick(sessionId, blockId, agentId, answers) {
    get().local(sessionId, { type: 'pick', id: blockId, answers });
    await wsClient.request('session.respondToPickOption', sessionId, { blockId, response: { agentId, answers } });
  },
  async respondPlanExit(sessionId, blockId, agentId, selected) {
    get().local(sessionId, { type: 'plan-exit', id: blockId, selected });
    await wsClient.request('session.respondToPlanExit', sessionId, { blockId, response: { agentId, selected } });
    // 对齐参考实现：退出计划后切回 Agent 模式
    await get().setAgentMode(sessionId, 'Agent');
  },
  async setAgentMode(sessionId, mode) {
    get().local(sessionId, { type: 'agentMode', mode });
    await wsClient.request('session.updateAgentMode', sessionId, { mode });
  },
  async setPermissionLevel(sessionId, level) {
    get().local(sessionId, { type: 'permissionLevel', level });
    await wsClient.request('session.updatePermissionLevel', sessionId, { level });
  },
  async getForkPreview(sessionId, messageUuid) { return wsClient.request('session.getForkPreview', sessionId, { messageUuid }); },
  async fork(sessionId, messageUuid, restoreFiles) { return wsClient.request('session.fork', sessionId, { messageUuid, options: { restoreFiles } }); },
}));

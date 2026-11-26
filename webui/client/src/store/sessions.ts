/** 会话 store：快照缓存 / 订阅 / 事件应用（与服务端共用 reducer）/ 会话动作 */
import { create } from 'zustand';
import { api } from '../api/http';
import { wsClient } from '../api/ws';
import type { SessionSnapshot, SessionRecord, AgentMode, PermissionLevel, EventFrame, GoalState, GoalUpdateReason, UserBlock, ImageAttachmentMeta, FileChangeItem, FileDiffResult, RevertFileResult } from '../../../shared/types';
import { applyEvent, applyLocal, LocalAction } from '../../../shared/transcript';
import { SERVER_EVENTS } from '../../../shared/protocol';
import { useApp } from './app';
import { t, type I18nKey } from '../i18n';
import { PASTE_RESTORE_MISSING } from '../features/chat/pasteAttachment';
import { rawFileUrl } from '../features/chat/fileRefs';

/**
 * 草稿里的超长粘贴：path/preview 发送时拼进 input 模板；text 留一份供「在文本框中显示」展开回输入框（不落快照）。
 * sent：回退 / 输入撤销回填的粘贴，文件已经发送过、归会话所有（core 随会话退场），删芯片时不删文件
 */
export interface DraftPaste { path: string; preview: string; text: string; sent?: boolean }
export interface Draft { text: string; images: { dataUrl: string; media_type: string; data: string }[]; pastes: DraftPaste[] }

interface SessionsState {
  snapshots: Record<string, SessionSnapshot>;
  loading: Record<string, boolean>;
  subscribed: Set<string>;
  drafts: Record<string, Draft>;
  /** 新会话草稿页预选的模式（提升到 store 供 DraftView 切换 Design 样式），发送建会话后下发并复位 */
  draftAgentMode: AgentMode;
  /** 会话级临时错误提示 */
  errors: Record<string, string | undefined>;
  /** 快照最近访问时间：超过保留上限时按此淘汰，释放整份快照占用的内存 */
  touched: Record<string, number>;
  /** 正在向上翻页（加载更早的轮次） */
  loadingOlder: Record<string, boolean>;

  open(sessionId: string): Promise<void>;
  warm(sessionId: string): void;
  loadSnapshot(sessionId: string): Promise<void>;
  /** 订阅（带游标补发）：服务端补不齐时重拉快照 */
  subscribe(sessionId: string, afterSeq: number): Promise<void>;
  /** 向上滚动时继续加载更早的轮次（快照分页）：前插到已有块之前，游标随 page 更新 */
  loadOlder(sessionId: string): Promise<void>;
  /** 释放非常驻且已空闲的会话快照，避免浏览过的每个会话（含 base64 附件）永久驻留 */
  pruneSnapshots(): void;
  applyFrame(frame: EventFrame): void;
  local(sessionId: string, action: LocalAction): void;
  setDraft(sessionId: string, fn: (d: Draft) => Draft): void;
  setDraftAgentMode(mode: AgentMode): void;

  /** originalInput：有粘贴附件时传用户实际打的正文（可为空串），供气泡 / 历史 / 标题使用；无粘贴不传 */
  send(sessionId: string, text: string, images?: Draft['images'], originalInput?: string): Promise<void>;
  /** 快问面板提问：与主输入框输入「/quickchat 问题」同一条发送链路，仅代拼前缀、不动聊天草稿 */
  sendQuickchat(sessionId: string, question: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** 长期目标操作：不走输入队列、立即生效（设定目标仍是普通输入 /goal <文本>）；状态随 goal:update 事件回到快照 */
  goalAction(sessionId: string, action: 'pause' | 'clear' | 'resume'): Promise<void>;
  updateGoal(sessionId: string, text: string): Promise<void>;
  respondPermission(sessionId: string, toolId: string, toolName: string, selected: string): Promise<void>;
  respondPick(sessionId: string, blockId: string, agentId: string, answers: string | null): Promise<void>;
  respondPlanExit(sessionId: string, blockId: string, agentId: string, selected: string): Promise<void>;
  setAgentMode(sessionId: string, mode: AgentMode): Promise<void>;
  setPermissionLevel(sessionId: string, level: PermissionLevel): Promise<void>;
  getForkPreview(sessionId: string, messageUuid: string): Promise<any>;
  fork(sessionId: string, messageUuid: string, restoreFiles: boolean): Promise<any>;
  /** 会话级「全部」视图：本会话受控写入过、已过滤与基线一致的文件 */
  getFileChanges(sessionId: string): Promise<FileChangeItem[]>;
  /** 单文件基线 diff（展开时按需取） */
  getFileDiff(sessionId: string, filePath: string): Promise<FileDiffResult>;
  /** 放弃修改：不传 filePaths 则恢复全部会话基线文件 */
  revertFileChanges(sessionId: string, filePaths?: string[]): Promise<RevertFileResult[]>;
  branchToNewChat(sessionId: string, beforeMessageUuid?: string): Promise<SessionRecord>;
}

export const emptyDraft = (): Draft => ({ text: '', images: [], pastes: [] });

/**
 * 把一条用户气泡还原成草稿内容（文字 + 图片 + 长文粘贴），回退与输入撤销共用。
 * 图片：快照里只留了原图路径，按 raw 接口读回字节转 base64（读不到说明原图已被清理，跳过）；
 * 旧快照没有路径的只有 dataUrl，直接拆回草稿形状。
 * 长文粘贴：转存文件仍在磁盘上，按绝对路径读回正文复用原路径；文件已被退场清理或删除的跳过，计入 missing。
 */
async function attachmentImage(sessionId: string, a: ImageAttachmentMeta): Promise<Draft['images'][number] | null> {
  if (a.dataUrl) return { dataUrl: a.dataUrl, media_type: a.media_type, data: a.dataUrl.split(',')[1] || '' };
  if (!a.path) return null;
  try {
    const res = await fetch(rawFileUrl(sessionId, a.path));
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const data = btoa(bin);
    return { dataUrl: `data:${a.media_type};base64,${data}`, media_type: a.media_type, data };
  } catch { return null; }
}

export async function draftFromUserBlock(sessionId: string, block: UserBlock): Promise<Draft & { missing: number }> {
  let missing = 0;
  const images = (await Promise.all((block.attachments || []).map(a => attachmentImage(sessionId, a))))
    .filter((i): i is Draft['images'][number] => !!i);
  const pastes = (await Promise.all((block.pastes || []).map(async (p): Promise<DraftPaste | null> => {
    try {
      const r = await api<{ content: string }>('POST', `/api/sessions/${sessionId}/file`, { path: p.path });
      return { path: p.path, preview: p.preview, text: r.content, sent: true };
    } catch { missing++; return null; }
  }))).filter((p): p is DraftPaste => !!p);
  return { text: block.text, images, pastes, missing };
}

/** 输入撤销回填：草稿为空直接填；已有内容时撤销的文字前插并换行，图片和粘贴排在已有内容之前，粘贴按路径去重 */
function restoreRetractedInput(sessionId: string, block: UserBlock) {
  draftFromUserBlock(sessionId, block).then(r => {
    useSessions.getState().setDraft(sessionId, d => ({
      text: r.text && d.text.trim() ? `${r.text}\n${d.text}` : (r.text || d.text),
      images: [...r.images, ...d.images],
      pastes: [...r.pastes.filter(p => !d.pastes.some(x => x.path === p.path)), ...d.pastes],
    }));
    if (r.missing) useApp.getState().toast(PASTE_RESTORE_MISSING, 'warn');
  }).catch(() => undefined);
}

let wired = false;
/** 页面隐藏期间丢弃过帧的会话：回到前台时用一次快照拉取对齐 */
const hiddenSkipped = new Set<string>();
/** 常驻会话视图之外的快照保留上限 */
const MAX_SNAPSHOT_VIEWS = 12;

export const useSessions = create<SessionsState>((set, get) => ({
  snapshots: {},
  loading: {},
  subscribed: new Set(),
  drafts: {},
  draftAgentMode: 'Agent',
  errors: {},
  touched: {},
  loadingOlder: {},

  async open(sessionId) {
    if (!wired) {
      wired = true;
      wsClient.onFrame(frame => {
        if ('sessionId' in frame && frame.sessionId && typeof (frame as any).seq === 'number') get().applyFrame(frame as EventFrame);
        else if (frame.event === SERVER_EVENTS.sessionResync && frame.data?.sessionId) get().loadSnapshot(frame.data.sessionId).catch(() => undefined);
      });
      // 重连后重新订阅全部浏览过的会话（带 afterSeq 补发）；只预热当前正在看的那个。
      // 首屏 open() 正在拉快照时不重复拉：那次请求返回后本来就会补订阅
      wsClient.onOpen(() => {
        const view = useApp.getState().view;
        for (const id of get().subscribed) {
          if (get().loading[id]) continue;
          get().loadSnapshot(id).then(() => { if (view.type === 'chat' && view.sessionId === id) get().warm(id); }).catch(() => undefined);
        }
      });
      // 回到前台：隐藏期间丢弃过帧的会话用一次快照拉取对齐，比补放几百上千帧划算
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        const ids = [...hiddenSkipped];
        hiddenSkipped.clear();
        for (const id of ids) if (get().snapshots[id]) get().loadSnapshot(id).catch(() => undefined);
      });
    }
    set(s => ({ subscribed: new Set(s.subscribed).add(sessionId), touched: { ...s.touched, [sessionId]: Date.now() } }));
    // 同一页面内切回已打开过的会话：本地快照还在（含已上翻的历史），只补订阅。
    // 重拉只会拿到尾部页，已加载的历史连同滚动位置一起丢，切回时被钳回底部
    const cur = get().snapshots[sessionId];
    if (cur) await get().subscribe(sessionId, cur.seq);
    else await get().loadSnapshot(sessionId);
    get().pruneSnapshots();
    get().warm(sessionId);
  },

  pruneSnapshots() {
    const s = get();
    const ids = Object.keys(s.snapshots);
    if (ids.length <= MAX_SNAPSHOT_VIEWS) return;
    const app = useApp.getState();
    const keep = new Set(app.chatKeep);
    if (app.view.type === 'chat') keep.add(app.view.sessionId);
    const drop = ids
      .filter(id => !keep.has(id) && s.snapshots[id]?.state !== 'processing')
      .sort((a, b) => (s.touched[a] || 0) - (s.touched[b] || 0))
      .slice(0, ids.length - MAX_SNAPSHOT_VIEWS);
    if (!drop.length) return;
    set(st => {
      const snapshots = { ...st.snapshots };
      const subscribed = new Set(st.subscribed);
      const touched = { ...st.touched };
      for (const id of drop) { delete snapshots[id]; subscribed.delete(id); delete touched[id]; }
      return { snapshots, subscribed, touched };
    });
    // 快照释放后不再需要该会话的推送；状态圆点由服务端的 session:status 广播维持
    for (const id of drop) wsClient.request('session.unsubscribe', id).catch(() => undefined);
  },

  /** 预热：拉起该会话目录的 core worker（只在打开会话时调用，失败不影响 UI） */
  warm(sessionId) {
    if (wsClient.status !== 'open') return;
    wsClient.request('session.warm', sessionId, {}).catch(e => console.warn('[session] warm failed', e?.message));
  },

  /** 取快照 → 订阅补发（服务端补不齐会重拉一次） */
  async loadSnapshot(sessionId) {
    set(s => ({ loading: { ...s.loading, [sessionId]: true } }));
    try {
      const snap = await api<SessionSnapshot>('GET', `/api/sessions/${sessionId}/snapshot`);
      set(s => ({ snapshots: { ...s.snapshots, [sessionId]: snap } }));
      await get().subscribe(sessionId, snap.seq);
    } finally {
      set(s => ({ loading: { ...s.loading, [sessionId]: false } }));
    }
  },

  async subscribe(sessionId, afterSeq) {
    if (wsClient.status !== 'open') return;
    const r = await wsClient.request<{ seq: number; resync: boolean }>('session.subscribe', sessionId, { afterSeq });
    if (!r?.resync) return;
    const snap = await api<SessionSnapshot>('GET', `/api/sessions/${sessionId}/snapshot`);
    set(s => ({ snapshots: { ...s.snapshots, [sessionId]: snap } }));
  },

  /**
   * 向上翻页：按当前快照的 page.oldestBlockId 取更早的一页，前插到已有块之前。
   * 期间若快照被重拉（游标变了），丢弃这次结果，避免把尾部页重复拼进去。
   */
  async loadOlder(sessionId) {
    const cur = get().snapshots[sessionId];
    const oldest = cur?.page?.oldestBlockId;
    if (!cur?.page?.hasMore || !oldest || get().loadingOlder[sessionId]) return;
    set(s => ({ loadingOlder: { ...s.loadingOlder, [sessionId]: true } }));
    try {
      const older = await api<SessionSnapshot>('GET', `/api/sessions/${sessionId}/snapshot?before=${encodeURIComponent(oldest)}`);
      set(s => {
        const base = s.snapshots[sessionId];
        if (!base || base.page?.oldestBlockId !== oldest) return {};
        return { snapshots: { ...s.snapshots, [sessionId]: { ...base, blocks: [...older.blocks, ...base.blocks], page: older.page } } };
      });
    } catch { /* 翻页失败保持现状，下次滚动重试 */ } finally {
      set(s => ({ loadingOlder: { ...s.loadingOlder, [sessionId]: false } }));
    }
  },

  applyFrame(frame) {
    // 后台标签页不逐帧应用：先丢弃，回到前台时用一次快照对齐（见 open 里的 visibilitychange）
    if (document.hidden) { hiddenSkipped.add(frame.sessionId); return; }
    const cur = get().snapshots[frame.sessionId];
    if (!cur) return;
    if (frame.seq <= cur.seq) return; // 重放/重复
    if (frame.seq > cur.seq + 1) {
      // 漏帧：回退到重新拉快照
      get().loadSnapshot(frame.sessionId).catch(() => undefined);
      return;
    }
    // 输入撤销：气泡随本事件从快照移除，移除前取出内容放回输入框。帧按 seq 去重，只会执行一次；
    // 有排队输入时 core 不会先转 idle，所以在事件到达时回填，不等状态变化
    if (frame.event === 'input:retracted') {
      const retracted = cur.blocks.find(b => b.kind === 'user' && b.inputId === frame.data?.inputId);
      if (retracted?.kind === 'user') restoreRetractedInput(frame.sessionId, retracted);
    }
    const next = applyEvent({ ...cur }, frame.event, frame.data, frame.seq);
    set(s => ({ snapshots: { ...s.snapshots, [frame.sessionId]: next } }));
    // 处理中 → 空闲且用户没在看（不是当前页面，或窗口/标签页不可见）：标记「后台完成」绿灯，打开会话或窗口重新可见时清除
    if (cur.state === 'processing' && next.state !== 'processing') {
      const app = useApp.getState();
      const viewing = app.view.type === 'chat' && app.view.sessionId === frame.sessionId && !document.hidden;
      if (!viewing) app.markDoneUnread(frame.sessionId);
    }
    // quickchat 回答到达：自动展开右侧「快问」标签
    if (frame.event === 'quickchat:response' && frame.data?.question) {
      useApp.getState().openQuickchatTab(frame.sessionId);
    }
    if (frame.event === 'session:error') {
      useApp.getState().toast(frame.data?.error?.message || t('chat.sessionError'), 'error');
    }
    // 长期目标：只对用户无法自行解释的暂停弹 toast（系统因上限 / 无进展 / 非 Agent 模式在轮末延迟暂停），
    // 用户自己中断（paused）和 API 报错（已有 session:error 提示）不弹；/goal 回显弹当前状态；
    // 完成时状态条直接消失，弹一次 info 作反馈；其余只靠状态条随快照变化
    if (frame.event === 'goal:update') {
      const reason = frame.data?.reason as GoalUpdateReason | undefined;
      const goal = frame.data?.goal as GoalState | null | undefined;
      const toast = useApp.getState().toast;
      if (reason === 'status') toast(goal ? t(`goal.status.${goal.status}` as I18nKey) : t('goal.none'), 'info');
      else if (reason === 'completed') toast(t('goal.status.completed'), 'info');
      else if (reason === 'noProgress' || reason === 'maxRounds' || reason === 'mode') toast(t(`goal.reason.${reason}` as I18nKey), 'warn');
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

  setDraftAgentMode(mode) { set({ draftAgentMode: mode }); },

  async send(sessionId, text, images = [], originalInput) {
    const attachments = images.map(i => ({ type: 'image', data: i.data, media_type: i.media_type }));
    // 乐观回显：回车立即出气泡、清空输入框，不等 core 的 input:received（worker 冷启动时可达数秒）；
    // 正式事件到达时 reducer 整体替换 pending 块
    const pendingId = `user:pending:${Date.now()}`;
    const draft = get().drafts[sessionId];
    get().local(sessionId, { type: 'user-pending', id: pendingId, input: text, originalInput, attachments: images.map(i => ({ media_type: i.media_type, data: i.data })) });
    get().setDraft(sessionId, () => emptyDraft());
    try {
      await wsClient.request('session.processUserInput', sessionId, { input: text, originalInput, attachments: attachments.length ? attachments : undefined });
      // 兜底：worker 先发事件再回应答、服务端同步转发，应答到达时该有的输入事件已应用；
      // 此时 pending 仍在说明 core 没发输入事件（/quickchat 旁路等），直接撤掉，避免永久残留并卡住分支
      get().local(sessionId, { type: 'user-pending-clear', id: pendingId });
    } catch (e) {
      // 失败：等待期间用户没再输入 → 撤气泡、草稿还回输入框；已在写新内容 → 不覆盖草稿，气泡留着标记失败供复制
      const cur = get().drafts[sessionId];
      const untouched = !cur || (!cur.text.trim() && !cur.images.length && !cur.pastes.length);
      if (untouched) {
        get().local(sessionId, { type: 'user-pending-clear', id: pendingId });
        if (draft) get().setDraft(sessionId, () => draft);
      } else {
        get().local(sessionId, { type: 'user-pending-failed', id: pendingId });
      }
      throw e;
    }
  },
  async sendQuickchat(sessionId, question) {
    await wsClient.request('session.processUserInput', sessionId, { input: `/quickchat ${question}` });
  },
  async interrupt(sessionId) { await wsClient.request('session.interrupt', sessionId, {}); },
  async goalAction(sessionId, action) {
    const map = { pause: 'session.pauseGoal', clear: 'session.clearGoal', resume: 'session.resumeGoal' } as const;
    await wsClient.request(map[action], sessionId, {});
  },
  async updateGoal(sessionId, text) { await wsClient.request('session.updateGoal', sessionId, { text }); },
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
  async getFileChanges(sessionId) { return wsClient.request('session.getFileChanges', sessionId, {}); },
  async getFileDiff(sessionId, filePath) { return wsClient.request('session.getFileDiff', sessionId, { filePath }); },
  async revertFileChanges(sessionId, filePaths) { return wsClient.request('session.revertFileChanges', sessionId, { filePaths }); },
  async branchToNewChat(sessionId, beforeMessageUuid) {
    const result = await api<{ record: SessionRecord; snapshot: SessionSnapshot }>('POST', `/api/sessions/${sessionId}/branch`,
      beforeMessageUuid !== undefined ? { beforeMessageUuid } : undefined);
    set(s => ({ snapshots: { ...s.snapshots, [result.record.id]: result.snapshot } }));
    // registry:update 通常先到；本地 upsert 兜底，保证切换视图时记录一定存在。
    useApp.setState(s => ({
      registry: {
        ...s.registry,
        sessions: s.registry.sessions.some(x => x.id === result.record.id)
          ? s.registry.sessions.map(x => x.id === result.record.id ? result.record : x)
          : [...s.registry.sessions, result.record],
      },
    }));
    return result.record;
  },
}));

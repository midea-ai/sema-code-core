/**
 * SessionManager：把「注册表 + worker 池 + 快照/事件缓冲 + 前端订阅」串起来。
 * - 每个会话一份 SessionSnapshot（服务端权威），事件按 seq 缓冲用于断线补发
 * - 会话的 worker 按需（订阅/发消息时）拉起并 session.create({sessionId}) 恢复
 */
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { WorkerPool, WorkerHandle } from './workers/pool';
import { RegistryStore, TRANSCRIPT_DIR, CONFIG_WORKSPACE, SEMA_DOCS_ROOT, writeJsonAtomic, removeEmptyDateParent } from './registry/registry';
import type { CronGroup, CronTask, EventFrame, SessionRecord, SessionSnapshot } from '../../shared/types';
import { applyEvent, applyLocal, createSnapshot, pendingBlocks } from '../../shared/transcript';
import { SERVER_EVENTS } from '../../shared/protocol';
import { readPersistedCron, readPersistedTasks } from './workers/cronFile';

const BUFFER_MAX = 3000;
const SAVE_DEBOUNCE_MS = 500;
/** 空闲会话回收阈值：超时的常驻 SemaSession 关闭（历史已落盘，下次操作自动恢复） */
const SESSION_IDLE_MS = 20 * 60_000;
/** warm（打开会话预热）宽限期：期间没有真实输入即可回收，避免纯浏览历史会话长期续命 */
const WARM_GRACE_MS = 5 * 60_000;
/** 每个 worker 常驻 SemaSession 上限，超出部分按最旧优先回收 */
const MAX_LIVE_SESSIONS = 8;
/** cron keeper：持久化定时任务距触发不足该时长时，提前拉起 worker + 一个会话以便注入 */
const CRON_KEEPER_LEAD_MS = 3 * 60_000;
/** 已过触发时刻多久以内仍尝试拉起（core 加载时周期任务从 now 重算，一次性任务过期即丢，只是兜底） */
const CRON_KEEPER_LATE_MS = 60_000;
/** keeper 拉起的会话在触发时刻之后再保活多久（覆盖 core 60s tick + 执行排队的时间） */
const CRON_KEEP_AFTER_FIRE_MS = 5 * 60_000;
const CORE_WRITE_ACTIONS = new Set(['core.switchModel', 'core.addModel', 'core.delModel', 'core.applyTaskModel']);

/** 退场上限：项目数、每项目会话数、独立会话数，超出按 lastActiveAt LRU 淘汰 */
const PROJECT_LIMIT = 30;
const SESSIONS_PER_PROJECT_LIMIT = 50;
const STANDALONE_SESSION_LIMIT = 50;

export interface Subscriber {
  send(frame: any): void;
}

interface Runtime {
  snapshot: SessionSnapshot;
  buffer: EventFrame[];
  subscribers: Set<Subscriber>;
  saveTimer?: NodeJS.Timeout;
  /** 正在拉起 worker/创建会话的 promise（去重） */
  ensuring?: Promise<WorkerHandle>;
  /** cron keeper 为注入定时任务拉起的会话：该时刻前不做会话回收/退场（不改 lastActiveAt，不影响侧边栏排序） */
  keepUntil?: number;
  /** 最近一次拉活（warm/任何会话动作）时间：只提供 WARM_GRACE_MS 的短宽限，不改 lastActiveAt 以免影响侧边栏排序 */
  lastWarmAt?: number;
}

export class SessionManager extends EventEmitter {
  private runtimes = new Map<string, Runtime>();
  readonly pool: WorkerPool;
  private sessionReapTimer: NodeJS.Timeout;
  private cronKeeperTimer: NodeJS.Timeout;
  /** 退场时清理会话关联终端的钩子（由入口注入 TerminalManager.killBySession） */
  killTerminals?: (sid: string) => void;
  private evicting = false;
  private branching = new Set<string>();

  constructor(readonly registry: RegistryStore, entryPath: string) {
    super();
    this.pool = new WorkerPool({
      entryPath,
      maxWorkers: () => registry.getSettings().maxWorkers ?? 8,
      exemptDirs: new Set([CONFIG_WORKSPACE]),
      getCoreConfig: () => registry.getSettings().coreConfig,
      isSessionBusy: (sid) => {
        const rt = this.runtimes.get(sid);
        return !!rt && (rt.snapshot.state === 'processing' || pendingBlocks(rt.snapshot).length > 0);
      },
      onCronWorkerReclaimed: (dir, sids, reason) => this.onCronWorkerReclaimed(dir, sids, reason),
    });
    this.sessionReapTimer = setInterval(() => { void this.reapSessions().catch(() => undefined); }, 60_000);
    this.sessionReapTimer.unref?.();
    this.cronKeeperTimer = setInterval(() => { void this.cronKeeperTick().catch(() => undefined); }, 60_000);
    this.cronKeeperTimer.unref?.();
    // 启动即跑一轮：服务重启期间临近触发的持久化任务尽快接管
    setTimeout(() => { void this.cronKeeperTick().catch(() => undefined); }, 2_000).unref?.();
    this.pool.on('event', (dir: string, sid: string, event: string, data: any) => this.onEvent(sid, event, data));
    this.pool.on('proc-event', (workingDir: string, event: string, data: any) => this.broadcastAll({ event, data, workingDir }));
    this.pool.on('exit', (dir: string, sids: string[], code: number | null) => this.onWorkerExit(sids, code));
  }

  // ==================== 快照 / 落盘 ====================

  private transcriptPath(id: string) { return path.join(TRANSCRIPT_DIR, `${id}.json`); }

  private loadRuntime(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (rt) return rt;
    const rec = this.registry.getSession(id);
    if (!rec) throw new Error(`会话不存在: ${id}`);
    let snapshot: SessionSnapshot | undefined;
    try {
      const file = this.transcriptPath(id);
      if (fs.existsSync(file)) snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* 损坏则重建 */ }
    if (!snapshot) snapshot = createSnapshot({ sessionId: id, workingDir: rec.workingDir, agentMode: rec.agentMode, permissionLevel: rec.permissionLevel });
    // 归一化旧快照：遗留的排队输入从未被处理（队列随进程消失，也不在 core 历史里），
    // 移除以免错切轮次、卡住分支或提供无效回退锚点
    if (snapshot.blocks.some(b => b.kind === 'user' && b.queued)) {
      snapshot.blocks = snapshot.blocks.filter(b => !(b.kind === 'user' && b.queued));
    }
    // 服务端重启后：上次若停在 processing，标为中断
    if (snapshot.state === 'processing') {
      applyEvent(snapshot, 'session:interrupted', { agentId: 'main', content: '服务已重启，本轮已中断' }, snapshot.seq + 1);
      applyEvent(snapshot, 'state:update', { state: 'idle' }, snapshot.seq + 1);
    }
    snapshot.workingDir = rec.workingDir;
    rt = { snapshot, buffer: [], subscribers: new Set() };
    this.runtimes.set(id, rt);
    return rt;
  }

  private scheduleSave(rt: Runtime) {
    if (rt.saveTimer) return;
    rt.saveTimer = setTimeout(() => {
      rt.saveTimer = undefined;
      try { writeJsonAtomic(this.transcriptPath(rt.snapshot.sessionId), rt.snapshot); } catch (e) { console.error('[transcript] save failed', e); }
    }, SAVE_DEBOUNCE_MS);
  }

  getSnapshot(id: string): SessionSnapshot { return this.loadRuntime(id).snapshot; }

  // ==================== 事件 ====================

  private onEvent(sid: string, event: string, data: any) {
    let rt: Runtime;
    try { rt = this.loadRuntime(sid); } catch { return; }
    const seq = rt.snapshot.seq + 1;
    applyEvent(rt.snapshot, event, data, seq);
    const frame: EventFrame = { event, sessionId: sid, seq, data };
    rt.buffer.push(frame);
    if (rt.buffer.length > BUFFER_MAX) rt.buffer.splice(0, rt.buffer.length - BUFFER_MAX);
    for (const s of rt.subscribers) s.send(frame);
    this.scheduleSave(rt);

    // 副作用：注册表标题 / 活跃时间
    if (event === 'topic:update' && data?.title) {
      this.registry.updateSession(sid, { title: String(data.title) });
      this.broadcastRegistry();
    } else if (event === 'input:received' && data?.source === 'cron') {
      // 定时任务触发：给所在 worker 续命（LRU/空闲判定用），但不更新会话 lastActiveAt（自动输入不算用户活跃）
      const rec = this.registry.getSession(sid);
      const w = rec ? this.pool.get(rec.workingDir) : undefined;
      if (w?.alive) w.lastUsed = Date.now();
    } else if (event === 'input:processing') {
      const rec = this.registry.getSession(sid);
      // 自动来源输入（cron 等）不作为会话标题
      if (rec && !rec.title && (!data?.source || data.source === 'user')) {
        const t = String(data?.originalInput || data?.input || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (t) this.registry.updateSession(sid, { title: t });
      }
      this.registry.touchSession(sid);
      this.broadcastRegistry();
    } else if (event === 'permissionLevel:update' && data?.level) {
      this.registry.updateSession(sid, { permissionLevel: data.level });
    }
  }

  private onWorkerExit(sids: string[], code: number | null) {
    for (const sid of sids) {
      const rt = this.runtimes.get(sid);
      if (!rt) continue;
      if (rt.snapshot.state === 'processing' || pendingBlocks(rt.snapshot).length) {
        this.onEvent(sid, 'session:interrupted', { agentId: 'main', content: `core 进程已退出（code ${code}）` });
        this.onEvent(sid, 'state:update', { state: 'idle' });
      }
    }
    this.broadcastLiveness();
  }

  private broadcastAll(frame: any) {
    const seen = new Set<Subscriber>();
    for (const rt of this.runtimes.values()) for (const s of rt.subscribers) seen.add(s);
    for (const s of this.globalSubscribers) seen.add(s);
    for (const s of seen) s.send(frame);
  }

  /** 全局订阅者（所有 WS 连接），用于 registry/model 更新广播 */
  readonly globalSubscribers = new Set<Subscriber>();
  broadcastRegistry() { this.broadcastAll({ event: SERVER_EVENTS.registryUpdate, data: this.registry.snapshot() }); }

  /** 存活会话：worker 进程活着且其中已创建该 SemaSession */
  liveSessionIds(): string[] {
    return this.pool.list().filter(w => w.alive).flatMap(w => [...w.sessions]);
  }
  private broadcastLiveness() { this.broadcastAll({ event: SERVER_EVENTS.livenessUpdate, data: { sessions: this.liveSessionIds() } }); }

  // ==================== 订阅 ====================

  subscribe(sub: Subscriber, sid: string, afterSeq?: number): { seq: number; resync: boolean } {
    const rt = this.loadRuntime(sid);
    rt.subscribers.add(sub);
    // 订阅只收事件（左侧角标/后台会话用），不拉起 worker；worker 由 session.warm（打开会话时）或实际动作按需拉起
    if (afterSeq === undefined || afterSeq >= rt.snapshot.seq) return { seq: rt.snapshot.seq, resync: false };
    const oldest = rt.buffer[0]?.seq;
    if (oldest === undefined || oldest > afterSeq + 1) return { seq: rt.snapshot.seq, resync: true };
    for (const f of rt.buffer) if (f.seq > afterSeq) sub.send(f);
    return { seq: rt.snapshot.seq, resync: false };
  }

  unsubscribe(sub: Subscriber, sid?: string) {
    if (sid) { this.runtimes.get(sid)?.subscribers.delete(sub); return; }
    for (const rt of this.runtimes.values()) rt.subscribers.delete(sub);
  }

  // ==================== worker / 会话存活 ====================

  private async ensureLive(sid: string): Promise<WorkerHandle> {
    const rt = this.loadRuntime(sid);
    rt.lastWarmAt = Date.now();
    if (rt.ensuring) return rt.ensuring;
    const rec = this.registry.getSession(sid)!;
    rt.ensuring = (async () => {
      if (!fs.existsSync(rec.workingDir)) {
        if (rec.projectId) throw new Error(`项目目录不存在: ${rec.workingDir}`);
        fs.mkdirSync(rec.workingDir, { recursive: true }); // 独立会话目录被删：重建后继续
      }
      const w = await this.pool.acquire(rec.workingDir);
      if (!w.sessions.has(sid)) {
        await this.pool.request(w, 'session.create', undefined, {
          sessionId: sid, agentMode: rt.snapshot.agentMode, permissionLevel: rt.snapshot.permissionLevel,
        });
        w.sessions.add(sid);
        this.broadcastLiveness();
      }
      return w;
    })();
    try {
      return await rt.ensuring;
    } finally {
      rt.ensuring = undefined;
    }
  }

  /**
   * 进程级操作（模型/系统配置等全局 ~/.sema 配置）固定走专用 worker：
   * cwd 为 ~/.sema/webui/workspace（不在 macOS「文稿」授权范围内，也不会污染用户项目目录），与会话 worker 的回收互不影响。
   * 项目作用域的查询（P1：项目级 Skills/Agents/MCP 等）应按 projectId 路由到该项目的 worker，不走这里。
   */
  private async configWorker(): Promise<WorkerHandle> {
    fs.mkdirSync(CONFIG_WORKSPACE, { recursive: true });
    return this.pool.acquire(CONFIG_WORKSPACE);
  }

  // ==================== 动作分发 ====================

  async dispatch(action: string, sid: string | undefined, payload: any): Promise<any> {
    if (action.startsWith('core.')) {
      if (action === 'core.updateCoreConfig' || action === 'core.refreshSkills' || action === 'core.refreshMCPServerInfo') {
        // 广播到全部存活 worker（core 配置 / skill 列表 / MCP 连接均为进程内状态）；持久化由 http 层落盘
        await Promise.all(this.pool.list().filter(w => w.alive).map(w => this.pool.request(w, action, undefined, payload).catch(() => null)));
        return true;
      }
      const w = await this.configWorker();
      const result = await this.pool.request(w, action, undefined, payload);
      if (CORE_WRITE_ACTIONS.has(action)) {
        // 模型配置有进程内缓存：其他 worker 空闲即重启，忙者 idle 后重启
        this.pool.markStale(w);
        this.broadcastAll({ event: SERVER_EVENTS.modelUpdate, data: result });
      }
      return result;
    }

    // ---------- 项目级：按 projectId 路由到项目目录 worker ----------
    // project.warm：草稿页选中项目即拉起 worker（core 初始化会预载插件并联动加载 skills），
    // 首条消息免冷启动，也避免 skills 未加载完的时序窗口；失败静默（发消息时会走正式报错路径）
    if (action === 'project.warm' || action === 'project.getCommandsInfo') {
      const proj = this.registry.getProject(String(payload?.projectId || ''));
      if (!proj) throw new Error(`项目不存在: ${payload?.projectId}`);
      const w = await this.pool.acquire(proj.workingDir);
      if (action === 'project.warm') {
        // 顺带预载 commands/skills/agents 清单缓存，不阻塞返回
        void this.pool.request(w, 'core.getCommandsInfo', undefined, {}).catch(() => null);
        return true;
      }
      return this.pool.request(w, 'core.getCommandsInfo', undefined, {});
    }

    if (!sid) throw new Error('缺少 sessionId');
    const rt = this.loadRuntime(sid);
    if (action === 'session.warm') {
      // 点开会话时才拉起该目录的 worker 并恢复会话（按需创建）；其他 worker 不动，正在运行的会话继续执行
      await this.ensureLive(sid);
      return true;
    }

    switch (action) {
      case 'session.updateAgentMode':
        applyLocal(rt.snapshot, { type: 'agentMode', mode: payload.mode });
        this.registry.updateSession(sid, { agentMode: payload.mode });
        this.scheduleSave(rt);
        break;
      case 'session.updatePermissionLevel':
        applyLocal(rt.snapshot, { type: 'permissionLevel', level: payload.level });
        this.registry.updateSession(sid, { permissionLevel: payload.level });
        this.scheduleSave(rt);
        break;
      case 'session.respondToToolPermission':
        applyLocal(rt.snapshot, { type: 'permission', toolId: payload.response?.toolId, selected: payload.response?.selected });
        this.scheduleSave(rt);
        break;
      case 'session.respondToPickOption':
        applyLocal(rt.snapshot, { type: 'pick', id: payload.blockId, answers: payload.response?.answers ?? null });
        this.scheduleSave(rt);
        break;
      case 'session.respondToPlanExit':
        applyLocal(rt.snapshot, { type: 'plan-exit', id: payload.blockId, selected: payload.response?.selected });
        this.scheduleSave(rt);
        break;
      case 'session.processUserInput':
        this.registry.touchSession(sid);
        break;
    }

    const w = await this.ensureLive(sid);
    const result = await this.pool.request(w, action, sid, payload);
    if (action === 'session.interrupt') {
      await this.pool.request(w, 'session.stopAllTasks', sid, {}).catch(() => null);
    }
    if (action === 'session.fork' && result?.ok !== false) {
      // 原地回退：截断该用户消息及其后的块
      const uuid = payload.messageUuid;
      const idx = rt.snapshot.blocks.findIndex(b => b.kind === 'user' && b.inputId === uuid);
      if (idx >= 0) {
        rt.snapshot.blocks = rt.snapshot.blocks.slice(0, idx);
        rt.snapshot.turn = null;
        rt.snapshot.streamingId = undefined;
        this.scheduleSave(rt);
        for (const s of rt.subscribers) s.send({ event: SERVER_EVENTS.sessionResync, data: { sessionId: sid } });
      }
    }
    return result;
  }

  // ==================== 生命周期 ====================

  /** 新会话：建注册表记录 + 立刻拉起 worker；启动失败回滚注册表/transcript/独立目录，不留垃圾 */
  async createSession(opts: { projectId?: string }): Promise<{ record: SessionRecord; snapshot: SessionSnapshot }> {
    const rec = this.registry.createSession(opts);
    const rt = this.loadRuntime(rec.id);
    this.broadcastRegistry();
    try {
      await this.ensureLive(rec.id);
    } catch (e) {
      if (rt.saveTimer) clearTimeout(rt.saveTimer);
      this.runtimes.delete(rec.id);
      this.registry.removeSession(rec.id);
      try { fs.unlinkSync(this.transcriptPath(rec.id)); } catch { /* ignore */ }
      // 独立会话独占目录：本次刚创建的空目录，直接删除（不进废纸篓）
      if (!rec.projectId) { try { fs.rmSync(rec.workingDir, { recursive: true, force: true }); } catch { /* ignore */ } }
      this.broadcastRegistry();
      throw e;
    }
    // 新会话就绪后异步检查超限退场（新会话 lastActiveAt 最新，不会被淘汰）
    void this.evictOverflow();
    return { record: rec, snapshot: rt.snapshot };
  }

  /** 分支到新聊天：core 复制模型历史，WebUI 复制展示快照，并在同目录 worker 中创建新的 SemaSession。
   * beforeMessageUuid：截断锚点（某条用户输入的 inputId），历史截到该输入之前；不传则全量复制。 */
  async branchSession(sourceId: string, beforeMessageUuid?: string): Promise<{ record: SessionRecord; snapshot: SessionSnapshot }> {
    if (this.branching.has(sourceId)) throw new Error('正在创建分支，请勿重复操作');
    const source = this.registry.getSession(sourceId);
    if (!source) throw new Error('源会话不存在');
    const sourceRt = this.loadRuntime(sourceId);
    if (sourceRt.snapshot.state !== 'idle' || pendingBlocks(sourceRt.snapshot).length > 0
      || sourceRt.snapshot.blocks.some(b => b.kind === 'user' && b.queued)) {
      throw new Error('会话处理中，请等待空闲后再分支');
    }
    // 展示快照的截断位置：与 core 历史截断同锚点，找不到说明快照与历史不一致，直接拒绝
    const cutIdx = beforeMessageUuid !== undefined
      ? sourceRt.snapshot.blocks.findIndex(b => b.kind === 'user' && b.inputId === beforeMessageUuid)
      : -1;
    if (beforeMessageUuid !== undefined && cutIdx < 0) throw new Error('分支锚点不存在');

    this.branching.add(sourceId);
    let targetId: string | undefined;
    let targetOwned = false;
    try {
      const worker = await this.ensureLive(sourceId);
      const result = await this.pool.request(worker, 'session.branch', sourceId, { beforeMessageUuid });
      if (!result?.ok) throw new Error(result?.error || '分支失败');
      targetId = String(result.sessionId || '');
      if (!targetId || this.registry.getSession(targetId)) throw new Error('分支会话 ID 无效或已存在');
      targetOwned = true;

      const record = this.registry.createBranchedSession(sourceId, targetId);
      const cloned = structuredClone(sourceRt.snapshot);
      // 有锚点时展示快照同步截断（不含锚点消息及其后的块），与 core 复制的历史对齐
      if (cutIdx >= 0) cloned.blocks = cloned.blocks.slice(0, cutIdx);
      const snapshot: SessionSnapshot = {
        ...cloned,
        sessionId: record.id,
        workingDir: record.workingDir,
        seq: 0,
        state: 'idle',
        agentMode: record.agentMode,
        permissionLevel: record.permissionLevel,
        blocks: [...cloned.blocks, {
          kind: 'branch-origin', id: `branch-origin:${record.id}`, ts: Date.now(),
          sourceSessionId: source.id, sourceTitle: source.title || '原聊天',
        }],
        turn: null,
        streamingId: undefined,
        historyLoaded: true,
        quickchats: undefined,
      };
      const targetRt: Runtime = { snapshot, buffer: [], subscribers: new Set() };
      this.runtimes.set(record.id, targetRt);
      writeJsonAtomic(this.transcriptPath(record.id), snapshot);

      // record 与 runtime 已建立，session:ready 等事件可安全落入目标快照。
      await this.ensureLive(record.id);
      this.broadcastRegistry();
      void this.evictOverflow();
      return { record, snapshot: targetRt.snapshot };
    } catch (error) {
      if (targetId && targetOwned) {
        const targetRt = this.runtimes.get(targetId);
        if (targetRt?.saveTimer) clearTimeout(targetRt.saveTimer);
        this.runtimes.delete(targetId);
        this.registry.removeSession(targetId);
        try { fs.unlinkSync(this.transcriptPath(targetId)); } catch { /* ignore */ }
        const worker = this.pool.get(source.workingDir);
        if (worker?.alive && worker.sessions.has(targetId)) {
          await this.pool.request(worker, 'session.close', targetId, {}).catch(() => null);
          worker.sessions.delete(targetId);
          this.broadcastLiveness();
        }
        await this.dispatch('core.deleteSessionHistory', undefined, { sessionId: targetId, projectPath: source.workingDir }).catch(() => null);
        this.broadcastRegistry();
      }
      throw error;
    } finally {
      this.branching.delete(sourceId);
    }
  }

  async closeSession(sid: string) {
    const rec = this.registry.getSession(sid);
    if (rec) {
      const w = this.pool.get(rec.workingDir);
      if (w?.alive && w.sessions.has(sid)) {
        await this.pool.request(w, 'session.close', sid, {}).catch(() => null);
        w.sessions.delete(sid);
        this.broadcastLiveness();
      }
      // 目录即将删除且已无其他会话/项目引用时，必须先等以它为 cwd 的 worker 真正退出。
      if (w?.alive && (rec.managedWorkingDir ?? !rec.projectId)
        && !this.registry.hasWorkingDirReference(rec.workingDir, sid)) await this.pool.kill(w);
    }
    const rt = this.runtimes.get(sid);
    if (rt?.saveTimer) clearTimeout(rt.saveTimer);
    this.runtimes.delete(sid);
    try { fs.unlinkSync(this.transcriptPath(sid)); } catch { /* ignore */ }
  }

  isBusy(sid: string) {
    const rt = this.runtimes.get(sid);
    return !!rt && (rt.snapshot.state === 'processing' || pendingBlocks(rt.snapshot).length > 0);
  }

  // ==================== 超限退场 ====================

  /** 忙碌中、有前端订阅、或名下有非持久化定时任务的会话不参与退场 */
  private isEvictable(sid: string, cronGuard?: Set<string>): boolean {
    return !this.isBusy(sid) && (this.runtimes.get(sid)?.subscribers.size ?? 0) === 0 && !cronGuard?.has(sid) && !this.isKept(sid);
  }

  /** keeper 保活期内的会话（等待定时任务注入/执行） */
  private isKept(sid: string): boolean {
    const until = this.runtimes.get(sid)?.keepUntil;
    return until != null && until > Date.now();
  }

  /** 各存活 worker 的 worker.stats（失败的 worker 跳过） */
  private async workerStats(): Promise<Map<WorkerHandle, any>> {
    const out = new Map<WorkerHandle, any>();
    await Promise.all(this.pool.list().filter(w => w.alive).map(async w => {
      try { out.set(w, await this.pool.request(w, 'worker.stats', undefined, {}, 5_000, { bump: false })); } catch { /* 忙或已退出 */ }
    }));
    return out;
  }

  /** 名下有非持久化定时任务的会话集合（丢了就是真丢，退场/回收一律跳过） */
  private cronGuardedSessions(stats: Map<WorkerHandle, any>): Set<string> {
    const out = new Set<string>();
    for (const st of stats.values()) {
      for (const [sid, n] of Object.entries(st?.cron?.nonPersisted || {})) if (Number(n) > 0) out.add(sid);
    }
    return out;
  }

  /** 目录下是否仍有启用的持久化定时任务（退场项目时跳过，留给更旧的无任务项目先退） */
  private hasPersistedCron(workingDir: string): boolean {
    try { return readPersistedCron(workingDir).active > 0; } catch { return false; }
  }

  /** 退场一个会话：杀终端 → 关闭对应 SemaSession → 删 transcript → 移除注册表记录 */
  private async evictSession(sid: string): Promise<SessionRecord | undefined> {
    this.killTerminals?.(sid);
    await this.closeSession(sid);
    return this.registry.removeSession(sid);
  }

  /**
   * 超限退场（LRU，均按 lastActiveAt）：
   * 1. 独立会话超 {@link STANDALONE_SESSION_LIMIT}：移除注册表/transcript + 硬删独占目录 + 删 core 对应 history 项目
   * 2. 项目内会话超 {@link SESSIONS_PER_PROJECT_LIMIT}：移除注册表/transcript + 删 core 该会话历史文件（项目目录不动）
   * 3. 项目超 {@link PROJECT_LIMIT}：仅移除索引及其会话记录/transcript，磁盘与 core history 均保留，重新导入可恢复
   */
  async evictOverflow(): Promise<void> {
    if (this.evicting) return;
    this.evicting = true;
    try {
      let changed = false;
      const cronGuard = this.cronGuardedSessions(await this.workerStats());
      const byActiveDesc = (a: { lastActiveAt: number }, b: { lastActiveAt: number }) => b.lastActiveAt - a.lastActiveAt;

      // 1) 独立会话
      const standalone = this.registry.listSessions().filter(s => !s.projectId).sort(byActiveDesc);
      for (const rec of standalone.slice(STANDALONE_SESSION_LIMIT)) {
        if (!this.isEvictable(rec.id, cronGuard)) continue;
        await this.evictSession(rec.id);
        const hasOtherRef = this.registry.hasWorkingDirReference(rec.workingDir);
        // 仅 WebUI 管理且已无引用的目录可硬删；共享目录只清理本会话产物。
        const managedRoot = path.resolve(SEMA_DOCS_ROOT) + path.sep;
        if ((rec.managedWorkingDir ?? !rec.projectId) && !hasOtherRef && path.resolve(rec.workingDir).startsWith(managedRoot)) {
          try { fs.rmSync(rec.workingDir, { recursive: true, force: true }); } catch { /* ignore */ }
          removeEmptyDateParent(rec.workingDir);
          await this.dispatch('core.deleteProjectHistory', undefined, { projectPath: rec.workingDir })
            .catch((e: any) => console.error('[evict] 删除 history 项目失败:', e?.message || e));
        } else {
          await this.dispatch('core.deleteSessionHistory', undefined, { sessionId: rec.id, projectPath: rec.workingDir })
            .catch((e: any) => console.error('[evict] 删除会话历史失败:', e?.message || e));
        }
        console.log(`[evict] 独立会话退场: ${rec.id}`);
        changed = true;
      }

      // 2) 项目内会话
      const byProject = new Map<string, SessionRecord[]>();
      for (const s of this.registry.listSessions()) {
        if (!s.projectId) continue;
        const list = byProject.get(s.projectId) || [];
        list.push(s);
        byProject.set(s.projectId, list);
      }
      for (const [pid, list] of byProject) {
        const proj = this.registry.getProject(pid);
        list.sort(byActiveDesc);
        for (const rec of list.slice(SESSIONS_PER_PROJECT_LIMIT)) {
          if (!this.isEvictable(rec.id, cronGuard)) continue;
          await this.evictSession(rec.id);
          await this.dispatch('core.deleteSessionHistory', undefined, { sessionId: rec.id, projectPath: proj?.workingDir || rec.workingDir })
            .catch((e: any) => console.error('[evict] 删除会话历史失败:', e?.message || e));
          console.log(`[evict] 项目会话退场: ${rec.id} (项目 ${proj?.name || pid})`);
          changed = true;
        }
      }

      // 3) 项目
      const projects = [...this.registry.snapshot().projects].sort(byActiveDesc);
      for (const proj of projects.slice(PROJECT_LIMIT)) {
        const sess = this.registry.listSessions().filter(s => s.projectId === proj.id);
        if (sess.some(s => !this.isEvictable(s.id, cronGuard))) continue;
        if (this.hasPersistedCron(proj.workingDir)) continue;
        for (const s of sess) { this.killTerminals?.(s.id); await this.closeSession(s.id); }
        this.registry.removeProject(proj.id);
        console.log(`[evict] 项目索引退场: ${proj.name}（磁盘与 history 保留）`);
        changed = true;
      }

      if (changed) this.broadcastRegistry();
    } catch (e: any) {
      console.error('[evict] 退场失败:', e?.message || e);
    } finally {
      this.evicting = false;
    }
  }

  /**
   * 会话级回收：worker 内常驻的 SemaSession 空闲超时、或超出每 worker 上限时关闭。
   * 历史已由 core 落盘，用户再操作时 ensureLive 会自动 session.create 恢复，只回收内存态。
   * 忙会话（processing/未决交互）和有运行中后台任务的会话不回收。
   */
  private async reapSessions() {
    const now = Date.now();
    for (const w of this.pool.list()) {
      if (!w.alive) continue;
      // 名下有非持久化定时任务的会话不回收（关闭会话会连带清掉这些任务）
      let guarded = new Set<string>();
      try {
        const st = await this.pool.request(w, 'worker.stats', undefined, {}, 5_000, { bump: false });
        guarded = this.cronGuardedSessions(new Map([[w, st]]));
      } catch { continue; }
      const total = w.sessions.size;
      const idle = [...w.sessions]
        .filter(sid => !this.isBusy(sid) && !guarded.has(sid) && !this.isKept(sid))
        .map(sid => {
          const active = this.registry.getSession(sid)?.lastActiveAt ?? 0;
          const warm = this.runtimes.get(sid)?.lastWarmAt ?? 0;
          return { sid, t: Math.max(active, warm), active, warm };
        })
        .sort((a, b) => a.t - b.t);
      const excess = Math.max(0, total - MAX_LIVE_SESSIONS);
      for (let i = 0; i < idle.length; i++) {
        const { sid, active, warm } = idle[i];
        // 超限部分（最旧优先）无条件回收；其余仅回收空闲超时的：
        // 真实输入享受完整空闲阈值，warm（打开浏览/重连预热）只给短宽限
        if (i >= excess && (now - active <= SESSION_IDLE_MS || now - warm <= WARM_GRACE_MS)) continue;
        if (this.isBusy(sid)) continue;
        try {
          const tasks = await this.pool.request(w, 'session.getTaskList', sid, {}, 5_000, { bump: false });
          if (Array.isArray(tasks) && tasks.some((task: any) => task?.status === 'running')) continue;
          await this.pool.request(w, 'session.close', sid, {}, 10_000, { bump: false });
          w.sessions.delete(sid);
          this.broadcastLiveness();
        } catch { /* worker 忙或已退出，下一轮再试 */ }
      }
    }
  }

  // ==================== 定时任务守护 ====================

  /**
   * 持久化定时任务 worker 被回收后的处理：
   * - evict（触顶淘汰）：向该 worker 上的会话注入提示，用户能看到任务为何暂停
   * - idle / stale：正常路径，由 keeper 临近触发再拉起，不打扰用户
   */
  private onCronWorkerReclaimed(workingDir: string, sids: string[], reason: 'idle' | 'stale' | 'evict') {
    console.log(`[cron] worker 已回收（${reason}）dir=${workingDir}，持久化定时任务将在临近触发时由 keeper 拉起`);
    if (reason !== 'evict') return;
    for (const sid of sids) {
      if (!this.registry.getSession(sid)) continue;
      this.onEvent(sid, 'hook:notice', { kind: 'systemMessage', message: '进程数已达上限，本项目的定时任务进程已被回收；临近触发时会自动拉起，也可打开本项目任一会话立即恢复' });
    }
  }

  /**
   * cron keeper（每分钟）：扫描注册表里所有目录的持久化定时任务文件，
   * 距最近触发不足 {@link CRON_KEEPER_LEAD_MS} 且该目录没有"活着且带会话"的 worker 时，
   * 拉起该目录最近活跃的会话（worker + session.create），让 core 重载任务并按时触发。
   * 受 maxWorkers 约束：拉起失败只记日志，下一轮重试。
   */
  private async cronKeeperTick() {
    const now = Date.now();
    // 扫描范围 = 项目目录 ∪ 会话目录：项目下会话全被删/退场时任务文件仍在，也要能触发
    const dirs = new Map<string, { projectId?: string; sessions: SessionRecord[] }>();
    for (const p of this.registry.snapshot().projects) dirs.set(p.workingDir, { projectId: p.id, sessions: [] });
    for (const rec of this.registry.listSessions()) {
      const e = dirs.get(rec.workingDir) || { projectId: rec.projectId, sessions: [] };
      e.sessions.push(rec);
      dirs.set(rec.workingDir, e);
    }
    for (const [dir, { projectId, sessions }] of dirs) {
      if (!fs.existsSync(path.join(dir, '.sema', 'scheduled_tasks.json'))) continue;
      const sum = readPersistedCron(dir, now);
      if (!sum.active || sum.nextFireAt == null) continue;
      const delta = sum.nextFireAt - now;
      if (delta > CRON_KEEPER_LEAD_MS || delta < -CRON_KEEPER_LATE_MS) continue;

      const w = this.pool.get(dir);
      if (w?.alive && w.sessions.size > 0) {
        // 已有会话在 worker 里：仍给其中最近活跃的一个打保活标记，防止 reapSessions 在触发前把它关掉
        const live = [...w.sessions].map(id => this.registry.getSession(id)).filter((r): r is SessionRecord => !!r).sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
        if (live) this.loadRuntime(live.id).keepUntil = sum.nextFireAt + CRON_KEEP_AFTER_FIRE_MS;
        continue;
      }

      let target = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      try {
        if (!target) {
          // 项目下没有会话：新建一个作为注入目标（独立会话目录没有 projectId，不会走到这里）
          if (!projectId) continue;
          target = this.registry.createSession({ projectId });
          this.loadRuntime(target.id);
          this.broadcastRegistry();
          console.log(`[cron] keeper 为项目 ${dir} 新建会话 ${target.id} 以承接定时任务`);
        }
        const rt = this.loadRuntime(target.id);
        rt.keepUntil = sum.nextFireAt + CRON_KEEP_AFTER_FIRE_MS;
        await this.ensureLive(target.id);
        console.log(`[cron] keeper 已拉起 ${dir}（会话 ${target.id}），${Math.round(delta / 1000)}s 后触发`);
      } catch (e: any) {
        console.warn(`[cron] keeper 拉起失败 ${dir}: ${e?.message || e}`);
      }
    }
  }

  /**
   * 日程页：全部目录的定时任务。worker 存活 → 问 worker（含非持久化任务）；未拉起 → 读持久化文件。
   * 无任务的目录不返回；按最近触发时间升序。
   */
  async listAllCron(): Promise<CronGroup[]> {
    const now = Date.now();
    const dirs = new Map<string, SessionRecord[]>();
    for (const rec of this.registry.listSessions()) {
      const list = dirs.get(rec.workingDir) || [];
      list.push(rec);
      dirs.set(rec.workingDir, list);
    }
    for (const p of this.registry.snapshot().projects) if (!dirs.has(p.workingDir)) dirs.set(p.workingDir, []);
    const out: CronGroup[] = [];
    await Promise.all([...dirs].map(async ([dir, sessions]) => {
      const w = this.pool.get(dir);
      let tasks: CronTask[] = [];
      let live = false;
      if (w?.alive) {
        try { tasks = await this.pool.request(w, 'session.getCronTasks', undefined, {}, 5_000, { bump: false }); live = true; }
        catch { tasks = readPersistedTasks(dir, now); }
      } else {
        tasks = readPersistedTasks(dir, now);
      }
      if (!tasks.length) return;
      const latest = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
      const proj = latest?.projectId ? this.registry.getProject(latest.projectId) : this.registry.snapshot().projects.find(p => p.workingDir === dir);
      out.push({ workingDir: dir, projectId: proj?.id, projectName: proj?.name || (latest?.title || path.basename(dir)), live, latestSessionId: latest?.id, tasks });
    }));
    const soonest = (g: CronGroup) => Math.min(...g.tasks.filter(t => t.status).map(t => t.nextFireAt[0] ?? Infinity), Infinity);
    return out.sort((a, b) => soonest(a) - soonest(b));
  }

  /** 日程页操作：worker 存活直接发；未拉起则临时拉起（之后按空闲规则回收），保证文件/disabled 记录由 core 统一改写 */
  async cronAction(workingDir: string, action: 'delete' | 'enable' | 'disable', id: string): Promise<boolean> {
    const w = await this.pool.acquire(workingDir);
    const act = action === 'delete' ? 'session.deleteCronTask' : action === 'enable' ? 'session.enableCronTask' : 'session.disableCronTask';
    return this.pool.request(w, act, undefined, { id });
  }

  /** 会话状态摘要（左侧角标用） */
  statusMap(): Record<string, { state: string; pending: number }> {
    const out: Record<string, { state: string; pending: number }> = {};
    for (const [sid, rt] of this.runtimes) out[sid] = { state: rt.snapshot.state, pending: pendingBlocks(rt.snapshot).length };
    return out;
  }

  async dispose() {
    clearInterval(this.sessionReapTimer);
    clearInterval(this.cronKeeperTimer);
    for (const rt of this.runtimes.values()) {
      if (rt.saveTimer) { clearTimeout(rt.saveTimer); try { writeJsonAtomic(this.transcriptPath(rt.snapshot.sessionId), rt.snapshot); } catch { /* ignore */ } }
    }
    await this.pool.disposeAll();
  }
}

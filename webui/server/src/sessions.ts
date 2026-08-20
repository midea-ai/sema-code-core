/**
 * SessionManager：把「注册表 + worker 池 + 快照/事件缓冲 + 前端订阅」串起来。
 * - 每个会话一份 SessionSnapshot（服务端权威），事件按 seq 缓冲用于断线补发
 * - 会话的 worker 按需（订阅/发消息时）拉起并 session.create({sessionId}) 恢复
 */
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { WorkerPool, WorkerHandle } from './workers/pool';
import { RegistryStore, TRANSCRIPT_DIR, CONFIG_WORKSPACE, SEMA_DOCS_ROOT, writeJsonAtomic } from './registry/registry';
import type { EventFrame, SessionRecord, SessionSnapshot } from '../../shared/types';
import { applyEvent, applyLocal, createSnapshot, pendingBlocks } from '../../shared/transcript';
import { SERVER_EVENTS } from '../../shared/protocol';

const BUFFER_MAX = 3000;
const SAVE_DEBOUNCE_MS = 500;
/** 空闲会话回收阈值：超时的常驻 SemaSession 关闭（历史已落盘，下次操作自动恢复） */
const SESSION_IDLE_MS = 20 * 60_000;
/** 每个 worker 常驻 SemaSession 上限，超出部分按最旧优先回收 */
const MAX_LIVE_SESSIONS = 8;
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
}

export class SessionManager extends EventEmitter {
  private runtimes = new Map<string, Runtime>();
  readonly pool: WorkerPool;
  private sessionReapTimer: NodeJS.Timeout;
  /** 退场时清理会话关联终端的钩子（由入口注入 TerminalManager.killBySession） */
  killTerminals?: (sid: string) => void;
  private evicting = false;

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
    });
    this.sessionReapTimer = setInterval(() => { void this.reapSessions().catch(() => undefined); }, 60_000);
    this.sessionReapTimer.unref?.();
    this.pool.on('event', (dir: string, sid: string, event: string, data: any) => this.onEvent(sid, event, data));
    this.pool.on('proc-event', (event: string, data: any) => this.broadcastAll({ event, data }));
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
    } else if (event === 'input:processing') {
      const rec = this.registry.getSession(sid);
      if (rec && !rec.title) {
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
      if (action === 'core.updateCoreConfig') {
        // 广播到全部存活 worker（core 配置仅内存）；持久化由 http 层写 settings
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

  async closeSession(sid: string) {
    const rec = this.registry.getSession(sid);
    if (rec) {
      const w = this.pool.get(rec.workingDir);
      if (w?.alive && w.sessions.has(sid)) {
        await this.pool.request(w, 'session.close', sid, {}).catch(() => null);
        w.sessions.delete(sid);
      }
      // 独立会话独占目录：目录随后会被移入废纸篓，必须先等以它为 cwd 的 worker 真正退出
      if (w?.alive && !rec.projectId) await this.pool.kill(w);
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

  /** 忙碌中或有前端订阅的会话不参与退场 */
  private isEvictable(sid: string): boolean {
    return !this.isBusy(sid) && (this.runtimes.get(sid)?.subscribers.size ?? 0) === 0;
  }

  /** 退场一个会话：杀终端 → 关 worker 会话（独立会话等 worker 退出）→ 删 transcript → 移除注册表记录 */
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
      const byActiveDesc = (a: { lastActiveAt: number }, b: { lastActiveAt: number }) => b.lastActiveAt - a.lastActiveAt;

      // 1) 独立会话
      const standalone = this.registry.listSessions().filter(s => !s.projectId).sort(byActiveDesc);
      for (const rec of standalone.slice(STANDALONE_SESSION_LIMIT)) {
        if (!this.isEvictable(rec.id)) continue;
        await this.evictSession(rec.id);
        // 独占目录必须位于 ~/Documents/Sema 之下才删磁盘和 history，防御异常数据
        if (rec.workingDir.startsWith(SEMA_DOCS_ROOT + path.sep)) {
          try { fs.rmSync(rec.workingDir, { recursive: true, force: true }); } catch { /* ignore */ }
          await this.dispatch('core.deleteProjectHistory', undefined, { projectPath: rec.workingDir })
            .catch((e: any) => console.error('[evict] 删除 history 项目失败:', e?.message || e));
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
          if (!this.isEvictable(rec.id)) continue;
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
        if (sess.some(s => !this.isEvictable(s.id))) continue;
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
      const total = w.sessions.size;
      const idle = [...w.sessions]
        .filter(sid => !this.isBusy(sid))
        .map(sid => ({ sid, t: this.registry.getSession(sid)?.lastActiveAt ?? 0 }))
        .sort((a, b) => a.t - b.t);
      const excess = Math.max(0, total - MAX_LIVE_SESSIONS);
      for (let i = 0; i < idle.length; i++) {
        const { sid, t } = idle[i];
        // 超限部分（最旧优先）无条件回收；其余仅回收空闲超时的
        if (i >= excess && now - t <= SESSION_IDLE_MS) continue;
        if (this.isBusy(sid)) continue;
        try {
          const tasks = await this.pool.request(w, 'session.getTaskList', sid, {}, 5_000, { bump: false });
          if (Array.isArray(tasks) && tasks.some((task: any) => task?.status === 'running')) continue;
          await this.pool.request(w, 'session.close', sid, {}, 10_000, { bump: false });
          w.sessions.delete(sid);
        } catch { /* worker 忙或已退出，下一轮再试 */ }
      }
    }
  }

  /** 会话状态摘要（左侧角标用） */
  statusMap(): Record<string, { state: string; pending: number }> {
    const out: Record<string, { state: string; pending: number }> = {};
    for (const [sid, rt] of this.runtimes) out[sid] = { state: rt.snapshot.state, pending: pendingBlocks(rt.snapshot).length };
    return out;
  }

  async dispose() {
    clearInterval(this.sessionReapTimer);
    for (const rt of this.runtimes.values()) {
      if (rt.saveTimer) { clearTimeout(rt.saveTimer); try { writeJsonAtomic(this.transcriptPath(rt.snapshot.sessionId), rt.snapshot); } catch { /* ignore */ } }
    }
    await this.pool.disposeAll();
  }
}

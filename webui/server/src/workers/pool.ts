/**
 * Worker 池：按 workingDir fork core 子进程，按需拉起、常驻、空闲回收（LRU）。
 */
import { fork, ChildProcess } from 'child_process';
import fs from 'fs';
import { EventEmitter } from 'events';

export interface WorkerHandle {
  workingDir: string;
  child: ChildProcess;
  ready: Promise<void>;
  /** 该 worker 上已创建的会话 */
  sessions: Set<string>;
  lastUsed: number;
  /** 模型等全局配置已在别的 worker 变更，需要在空闲时重启 */
  stale: boolean;
  alive: boolean;
}

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export interface PoolOptions {
  entryPath: string;
  /** worker 硬上限（每次触顶时取值，settings 变更下次 acquire 生效）；内部 clamp 到 [2,16]，缺省 8 */
  maxWorkers?: () => number;
  idleMs?: number;
  /** 不计入上限、也不参与淘汰的目录（配置 worker） */
  exemptDirs?: Set<string>;
  /** 传给每个 worker 的 core 配置（不含 workingDir） */
  getCoreConfig: () => Record<string, any>;
  /** 会话是否忙（processing / 有未决请求），忙则不回收 */
  isSessionBusy: (sessionId: string) => boolean;
}

/**
 * 事件：
 *  'event'      (workingDir, sessionId, event, data)
 *  'proc-event' (event, data)
 *  'exit'       (workingDir, sessions: string[], code)  worker 退出（含崩溃）
 */
export class WorkerPool extends EventEmitter {
  private workers = new Map<string, WorkerHandle>();
  private pending = new Map<string, Pending>();
  private seq = 0;
  private timer: NodeJS.Timeout;

  constructor(private opts: PoolOptions) {
    super();
    this.timer = setInterval(() => this.reap(), 60_000);
    this.timer.unref?.();
  }

  get size() { return this.workers.size; }
  list() { return [...this.workers.values()]; }
  get(workingDir: string) { return this.workers.get(workingDir); }

  /** 硬上限（clamp 到 [2,16]，缺省 8） */
  private maxWorkers(): number {
    const v = Math.floor(this.opts.maxWorkers?.() ?? 8);
    return Math.min(16, Math.max(2, v || 8));
  }

  /** 计入上限的 worker 数（豁免目录不算） */
  private countedSize(): number {
    let n = 0;
    for (const w of this.workers.values()) if (!this.opts.exemptDirs?.has(w.workingDir)) n++;
    return n;
  }

  /** 获取或拉起 worker */
  async acquire(workingDir: string): Promise<WorkerHandle> {
    if (!fs.existsSync(workingDir)) throw new Error(`工作目录不存在: ${workingDir}`);
    let w = this.workers.get(workingDir);
    if (w && w.alive && !fs.existsSync(w.workingDir)) { void this.kill(w); w = undefined; }
    if (w && w.alive) {
      w.lastUsed = Date.now();
      await w.ready;
      return w;
    }
    // 硬上限（豁免目录不计数）：先回收最久未用且空闲的；均忙则拒绝，绝不超限 spawn
    if (!this.opts.exemptDirs?.has(workingDir)) {
      while (this.countedSize() >= this.maxWorkers()) {
        if (!(await this.evictOne())) {
          throw new Error(`已达 worker 进程上限(${this.maxWorkers()})且均在处理或有运行中任务，请等待其他会话完成或关闭部分会话`);
        }
      }
      // 回收等待期间，可能已有并发请求拉起了同目录 worker
      w = this.workers.get(workingDir);
      if (w && w.alive) { w.lastUsed = Date.now(); await w.ready; return w; }
    }
    w = this.spawn(workingDir);
    this.workers.set(workingDir, w);
    await w.ready;
    return w;
  }

  private spawn(workingDir: string): WorkerHandle {
    const child = fork(this.opts.entryPath, [], {
      cwd: workingDir,
      env: {
        ...process.env,
        SEMA_WEBUI_WORKING_DIR: workingDir,
        SEMA_WEBUI_CORE_CONFIG: JSON.stringify(this.opts.getCoreConfig()),
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const handle: WorkerHandle = {
      workingDir, child, sessions: new Set(), lastUsed: Date.now(), stale: false, alive: true,
      ready: new Promise<void>((resolve, reject) => {
        const onMsg = (m: any) => { if (m?.type === 'ready') { child.off('message', onMsg); resolve(); } };
        child.on('message', onMsg);
        child.once('exit', (code) => reject(new Error(`worker exited before ready (code ${code})`)));
      }),
    };
    handle.ready.catch(() => { /* 由 exit 事件统一处理 */ });

    child.on('message', (m: any) => {
      if (!m) return;
      if (m.type === 'res') {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || 'worker error'));
        }
      } else if (m.type === 'event') {
        this.emit('event', workingDir, m.sessionId, m.event, m.data);
      } else if (m.type === 'proc-event') {
        this.emit('proc-event', m.event, m.data);
      }
    });
    child.on('exit', (code) => {
      handle.alive = false;
      if (code && code !== 0) console.error(`[pool] worker pid=${child.pid} 异常退出 code=${code} dir=${workingDir}（若目录已被删除/移入废纸篓，请删除对应会话或重新创建）`);
      if (this.workers.get(workingDir) === handle) this.workers.delete(workingDir);
      // 该 worker 的未决请求全部失败
      for (const [id, p] of this.pending) {
        if (id.startsWith(`${handle.child.pid}:`)) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new Error('worker exited'));
        }
      }
      this.emit('exit', workingDir, [...handle.sessions], code);
    });
    console.log(`[pool] spawn worker pid=${child.pid} dir=${workingDir}`);
    return handle;
  }

  /** 向 worker 发请求；opts.bump=false 时不刷新 lastUsed（池内部的巡检查询，不影响 LRU/空闲判定） */
  request(w: WorkerHandle, action: string, sessionId: string | undefined, payload: any, timeoutMs = 120_000, opts?: { bump?: boolean }): Promise<any> {
    if (!w.alive) return Promise.reject(new Error('worker not alive'));
    if (opts?.bump !== false) w.lastUsed = Date.now();
    const id = `${w.child.pid}:${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker request timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.child.send({ type: 'req', id, action, sessionId, payload });
    });
  }

  /** 关闭 worker（优雅：断开 IPC 让子进程自行 dispose，5 秒未退出则 SIGKILL）；resolve 于进程真正退出 */
  kill(w: WorkerHandle): Promise<void> {
    if (!w.alive) return Promise.resolve();
    console.log(`[pool] kill worker pid=${w.child.pid} dir=${w.workingDir}`);
    const exited = new Promise<void>((resolve) => w.child.once('exit', () => resolve()));
    try { w.child.disconnect(); } catch { try { w.child.kill('SIGKILL'); } catch { /* ignore */ } }
    const t = setTimeout(() => { try { w.child.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
    t.unref?.();
    return exited.then(() => clearTimeout(t));
  }

  /** 空闲 = 无 processing、无未决交互请求的会话（订阅不算忙：worker 回收后按需恢复） */
  private isIdle(w: WorkerHandle): boolean {
    for (const sid of w.sessions) {
      if (this.opts.isSessionBusy(sid)) return false;
    }
    return true;
  }

  /** worker 上是否有运行中的后台任务（查询失败视为无：无响应的 worker 本就该回收） */
  private async hasRunningTasks(w: WorkerHandle): Promise<boolean> {
    try {
      const stats = await this.request(w, 'worker.stats', undefined, {}, 5_000, { bump: false });
      return Object.values(stats?.runningTasks || {}).some((n) => Number(n) > 0);
    } catch { return false; }
  }

  /** 尝试回收一个空闲 worker（先确认无运行中后台任务）；成功回收返回 true */
  private async tryReclaim(w: WorkerHandle): Promise<boolean> {
    if (!w.alive || !this.isIdle(w)) return false;
    if (await this.hasRunningTasks(w)) return false;
    if (!w.alive || !this.isIdle(w)) return false; // RPC 期间状态可能已变化
    await this.kill(w);
    return true;
  }

  /** 标记除 except 外所有 worker 为 stale，空闲者立即重启（实际是杀掉，下次按需拉起） */
  markStale(except?: WorkerHandle) {
    for (const w of this.workers.values()) {
      if (w === except) continue;
      w.stale = true;
      if (this.isIdle(w)) void this.tryReclaim(w);
    }
  }

  /** 淘汰一个最久未用且可回收的 worker（豁免目录除外）；无可回收返回 false */
  private async evictOne(): Promise<boolean> {
    const candidates = [...this.workers.values()]
      .filter(w => w.alive && !this.opts.exemptDirs?.has(w.workingDir) && this.isIdle(w))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const w of candidates) {
      if (await this.tryReclaim(w)) return true;
    }
    return false;
  }

  private reap() {
    const now = Date.now();
    const idleMs = this.opts.idleMs ?? 30 * 60_000;
    for (const w of this.workers.values()) {
      if (!this.isIdle(w)) continue;
      if (w.stale || now - w.lastUsed > idleMs) void this.tryReclaim(w);
    }
  }

  async disposeAll() {
    clearInterval(this.timer);
    await Promise.all([...this.workers.values()].map(w => this.kill(w)));
    this.workers.clear();
  }
}

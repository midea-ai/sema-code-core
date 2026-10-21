/**
 * Worker 池：按 workingDir 拉起 core worker，按需拉起、常驻、空闲回收（LRU）。
 * worker 缺省是 worker_threads 线程：没有进程创建开销（Windows 上每起一个 electron.exe 进程都要被杀毒按体积扫一遍，约 2 秒），
 * 每个线程独立 isolate、独立模块实例，与原来每进程一份等价。SEMA_WEBUI_WORKER_MODE=process 回退为 fork 子进程（留一个版本周期后删）。
 */
import { fork } from 'child_process';
import { SHARE_ENV, Worker } from 'worker_threads';
import fs from 'fs';
import { EventEmitter } from 'events';
import { logErr } from '../errlog';

/**
 * worker 的 stdout/stderr 整体丢弃，不到终端：core 的日志已落盘 ~/.sema/logs/，worker 真正要上报的事都走帧
 * （启动失败发 error 帧，由这里记 ~/.sema/webui/error.log）。不按内容过滤，第三方库的裸 console 一并静音。
 */
/** worker 载体：缺省线程；process 走旧的 fork 路径（回退开关） */
const WORKER_MODE: 'thread' | 'process' = process.env.SEMA_WEBUI_WORKER_MODE === 'process' ? 'process' : 'thread';

/**
 * 线程 / 子进程两种 worker 载体的统一接口，pool 只认这个接口。
 * 帧格式两种载体相同；线程模式下帧以 JSON 字符串经 postMessage 传，与进程模式 IPC 的 JSON 语义一致
 * （函数 / undefined 静默丢，Date 变字符串），不会像 structured clone 那样遇到函数就抛 DataCloneError。
 */
export interface WorkerBackend {
  /** 日志与 pending 键：进程为 pid，线程为 t<threadId> */
  id: string;
  send(msg: any): void;
  on(event: 'message' | 'exit' | 'error', fn: (...args: any[]) => void): void;
  /** 请求优雅退出：线程发 dispose 帧，进程断开 IPC；worker 自行 core.dispose() 后结束 */
  requestExit(): void;
  /** 优雅退出超时的兜底：线程 terminate，进程 SIGKILL */
  forceKill(): void;
}

function spawnThread(entryPath: string, workingDir: string, coreConfig: Record<string, any>): WorkerBackend {
  const worker = new Worker(entryPath, {
    workerData: { workingDir, coreConfig },
    // 共享进程的真实环境变量而不是拷贝：Node 给线程拷出来的 env 是大小写敏感的 map，Windows 上 process.env.PATH / SYSTEMROOT
    // 会读不到系统存成 Path / SystemRoot 的键（core 的 ComSpec / ProgramFiles 读取、MCP SDK 继承给子进程的 PATH 都受影响）；
    // 共享后与进程模式的视图一致。core 不写 process.env，共享无副作用
    env: SHARE_ENV,
    // true = 不自动透传到父进程 stdout/stderr；下面 resume 把流排空丢掉（不消费会在内存里积压）
    stdout: true,
    stderr: true,
    // 不设 resourceLimits：线程默认堆上限与主线程相同（Node 22 / Electron 44 实测一致），和进程模式等价；超限只结束该线程
  });
  worker.stdout.resume();
  worker.stderr.resume();
  const post = (msg: any) => worker.postMessage(JSON.stringify(msg));
  return {
    id: `t${worker.threadId}`,
    send: post,
    on: (event, fn) => {
      if (event === 'message') worker.on('message', (raw: unknown) => fn(typeof raw === 'string' ? JSON.parse(raw) : raw));
      else worker.on(event, fn);
    },
    requestExit: () => post({ type: 'dispose' }),
    forceKill: () => { void worker.terminate(); },
  };
}

function spawnProcess(entryPath: string, workingDir: string, coreConfig: Record<string, any>): WorkerBackend {
  const child = fork(entryPath, [], {
    cwd: workingDir,
    env: {
      ...process.env,
      SEMA_WEBUI_WORKING_DIR: workingDir,
      SEMA_WEBUI_CORE_CONFIG: JSON.stringify(coreConfig),
      // 宿主是 Electron 时 fork 用的是 Electron 二进制，显式让子进程按纯 Node 运行
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    // 脱离前台进程组：Ctrl+C 的 SIGINT 只打到主进程，worker 及其 MCP 子进程
    // 统一走 disconnect → core.dispose() 优雅关闭（主进程被 SIGKILL 时 IPC 断开同样触发）
    detached: true,
  });
  return {
    id: String(child.pid),
    send: (msg) => { child.send(msg); },
    on: (event, fn) => { child.on(event, fn); },
    // disconnect 后 IPC 通道立即不可用；通道已坏时直接 SIGKILL
    requestExit: () => { try { child.disconnect(); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } } },
    forceKill: () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } },
  };
}

export interface WorkerHandle {
  workingDir: string;
  /** 进程 pid 或线程 t<threadId>（日志用） */
  id: string;
  backend: WorkerBackend;
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
  /** 带着持久化定时任务的 worker 被回收后的通知（reason：idle=空闲超时 / stale=配置变更重启 / evict=触顶淘汰） */
  onCronWorkerReclaimed?: (workingDir: string, sessions: string[], reason: 'idle' | 'stale' | 'evict') => void;
}

/** worker.stats 返回的守护信息 */
export interface WorkerGuard {
  /** 有运行中后台任务，或存在非持久化定时任务：等同忙，不可回收 */
  busy: boolean;
  /** 只有持久化定时任务：弱守护，临近触发时不回收，其余时间可回收（由 keeper 临近触发再拉起） */
  cronWeak: boolean;
  nextFireAt: number | null;
}

/** 弱守护 worker：距下次触发不足该时长时不做空闲回收 */
const CRON_IDLE_GUARD_MS = 10 * 60_000;
/** 弱守护 worker：距下次触发不足该时长时不做 stale 重启 */
const CRON_STALE_GUARD_MS = 2 * 60_000;

/**
 * 事件：
 *  'event'      (workingDir, sessionId, event, data)
 *  'proc-event' (workingDir, event, data)
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

  /** 未触顶（预热类调用用：不为预热去淘汰别人） */
  hasCapacity(): boolean {
    return this.countedSize() < this.maxWorkers();
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
          throw new Error(`已达 worker 上限(${this.maxWorkers()})且均在处理或有运行中任务，请等待其他会话完成或关闭部分会话`);
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
    const coreConfig = this.opts.getCoreConfig();
    const backend = WORKER_MODE === 'thread'
      ? spawnThread(this.opts.entryPath, workingDir, coreConfig)
      : spawnProcess(this.opts.entryPath, workingDir, coreConfig);
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    const handle: WorkerHandle = {
      workingDir, id: backend.id, backend, sessions: new Set(), lastUsed: Date.now(), stale: false, alive: true,
      ready: new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }),
    };
    handle.ready.catch(() => { /* 由 exit 事件统一处理 */ });

    backend.on('message', (m: any) => {
      if (!m) return;
      if (m.type === 'ready') {
        resolveReady();
      } else if (m.type === 'res') {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || 'worker error'));
        }
      } else if (m.type === 'event') {
        this.emit('event', workingDir, m.sessionId, m.event, m.data);
      } else if (m.type === 'proc-event') {
        this.emit('proc-event', workingDir, m.event, m.data);
      } else if (m.type === 'error') {
        // worker 启动失败的原因（随后它会退出，exit 事件照常处理）
        logErr('pool', `worker id=${backend.id} 启动失败 dir=${workingDir}: ${m.message}`);
      }
    });
    // 进程：send() 写入已关闭的通道等场景会异步 emit error；线程：未捕获异常先 emit error 再 exit。无监听时都会升级为 uncaughtException
    backend.on('error', (err: any) => {
      // 传 Error 对象本身：errlog 会记堆栈，线程未捕获异常的堆栈随 error 事件原样带过来
      logErr('pool', `worker id=${backend.id} 错误 dir=${workingDir}:`, err);
      this.rejectPending(backend.id, err instanceof Error ? err : new Error(String(err)));
    });
    backend.on('exit', (code: number | null) => {
      handle.alive = false;
      rejectReady(new Error(`worker exited before ready (code ${code})`));
      if (code && code !== 0) logErr('pool', `worker id=${backend.id} 异常退出 code=${code} dir=${workingDir}（若目录已被删除/移入废纸篓，请删除对应会话或重新创建）`);
      if (this.workers.get(workingDir) === handle) this.workers.delete(workingDir);
      // 该 worker 的未决请求全部失败
      this.rejectPending(backend.id, new Error('worker exited'));
      this.emit('exit', workingDir, [...handle.sessions], code);
    });
    return handle;
  }

  /** 让某个 worker 的全部未决请求失败 */
  private rejectPending(workerId: string, err: Error) {
    for (const [id, p] of this.pending) {
      if (id.startsWith(`${workerId}:`)) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(err);
      }
    }
  }

  /** 向 worker 发请求；opts.bump=false 时不刷新 lastUsed（池内部的巡检查询，不影响 LRU/空闲判定） */
  request(w: WorkerHandle, action: string, sessionId: string | undefined, payload: any, timeoutMs = 120_000, opts?: { bump?: boolean }): Promise<any> {
    if (!w.alive) return Promise.reject(new Error('worker not alive'));
    if (opts?.bump !== false) w.lastUsed = Date.now();
    const id = `${w.id}:${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker request timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      w.backend.send({ type: 'req', id, action, sessionId, payload });
    });
  }

  /** 关闭 worker（优雅：请求 worker 自行 dispose 后退出，5 秒未退出则强制结束）；resolve 于 worker 真正退出 */
  kill(w: WorkerHandle): Promise<void> {
    if (!w.alive) return Promise.resolve();
    // 退出请求发出后通道随即不可用，但 exit 事件可能延迟数秒：
    // 先标记死亡并摘出池，避免这期间巡检路径（reapSessions 等）继续向它 send
    w.alive = false;
    if (this.workers.get(w.workingDir) === w) this.workers.delete(w.workingDir);
    const exited = new Promise<void>((resolve) => w.backend.on('exit', () => resolve()));
    w.backend.requestExit();
    const t = setTimeout(() => w.backend.forceKill(), 5000);
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

  /** 查询 worker 守护信息（查询失败视为无守护：无响应的 worker 本就该回收） */
  async guardOf(w: WorkerHandle): Promise<WorkerGuard> {
    try {
      const stats = await this.request(w, 'worker.stats', undefined, {}, 5_000, { bump: false });
      const running = Object.values(stats?.runningTasks || {}).some((n) => Number(n) > 0);
      const cron = stats?.cron || {};
      const nonPersisted = Object.values(cron.nonPersisted || {}).some((n) => Number(n) > 0);
      return { busy: running || nonPersisted, cronWeak: !nonPersisted && Number(cron.active) > 0, nextFireAt: cron.nextFireAt ?? null };
    } catch { return { busy: false, cronWeak: false, nextFireAt: null }; }
  }

  /**
   * 尝试回收一个空闲 worker；成功回收返回 true。
   * - busy（后台任务 / 非持久化定时任务）：不回收
   * - cronWeak（仅持久化定时任务）：距触发不足 guardMs 不回收；回收后通知 onCronWorkerReclaimed（keeper 临近触发再拉起）
   */
  private async tryReclaim(w: WorkerHandle, reason: 'idle' | 'stale' | 'evict', guardMs: number): Promise<boolean> {
    if (!w.alive || !this.isIdle(w)) return false;
    const g = await this.guardOf(w);
    if (g.busy) return false;
    if (g.cronWeak && g.nextFireAt != null && g.nextFireAt - Date.now() < guardMs) return false;
    if (!w.alive || !this.isIdle(w)) return false; // RPC 期间状态可能已变化
    const sids = [...w.sessions];
    await this.kill(w);
    if (g.cronWeak) this.opts.onCronWorkerReclaimed?.(w.workingDir, sids, reason);
    return true;
  }

  /**
   * 标记除 except 外所有 worker 为 stale，空闲者立即重启（实际是杀掉，下次按需拉起）。
   * 持久化定时任务 worker：距触发不足 2 分钟先不动，触发完由 reap 按 stale 重启；非持久化任务 worker 保持 stale，等降级后再处理
   */
  markStale(except?: WorkerHandle) {
    for (const w of this.workers.values()) {
      if (w === except) continue;
      w.stale = true;
      if (this.isIdle(w)) void this.tryReclaim(w, 'stale', CRON_STALE_GUARD_MS);
    }
  }

  /**
   * 淘汰一个最久未用且可回收的 worker（豁免目录除外）；无可回收返回 false。
   * 两轮：先只淘汰无定时任务的；都不行再淘汰只有持久化定时任务的（触顶场景下不看临近触发，由 keeper 补拉）
   */
  private async evictOne(): Promise<boolean> {
    const candidates = [...this.workers.values()]
      .filter(w => w.alive && !this.opts.exemptDirs?.has(w.workingDir) && this.isIdle(w))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const w of candidates) {
      if (await this.tryReclaim(w, 'evict', Infinity)) return true;
    }
    for (const w of candidates) {
      if (await this.tryReclaim(w, 'evict', -Infinity)) return true;
    }
    return false;
  }

  private reap() {
    const now = Date.now();
    const idleMs = this.opts.idleMs ?? 30 * 60_000;
    for (const w of this.workers.values()) {
      if (!this.isIdle(w)) continue;
      if (w.stale) void this.tryReclaim(w, 'stale', CRON_STALE_GUARD_MS);
      else if (now - w.lastUsed > idleMs) void this.tryReclaim(w, 'idle', CRON_IDLE_GUARD_MS);
    }
  }

  async disposeAll() {
    clearInterval(this.timer);
    await Promise.all([...this.workers.values()].map(w => this.kill(w)));
    this.workers.clear();
  }
}

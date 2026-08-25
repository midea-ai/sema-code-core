/**
 * WebSocket 客户端：请求/应答 + 事件分发 + 断线重连（重连后由 store 重新订阅）。
 * 状态：connecting / open / closed（退避重连中）/ unauthorized（token 被拒，停止重连）/ failed（连续失败超限，等手动重试）
 */
import { api, ApiError, getToken } from './http';
import type { EventFrame, ProcEventFrame, ResFrame } from '../../../shared/types';

type Listener = (frame: EventFrame | ProcEventFrame) => void;
export type WsStatus = 'connecting' | 'open' | 'closed' | 'unauthorized' | 'failed';
/** 连续失败多少次后放弃自动重连（退避封顶 10s，约 1 分钟） */
const MAX_RETRY = 8;
interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }

export class WsClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<Listener>();
  private openListeners = new Set<() => void>();
  private statusListeners = new Set<(s: WsStatus) => void>();
  private seq = 0;
  private retry = 0;
  private closedByUser = false;
  private reconnectTimer = 0;
  status: WsStatus = 'closed';

  /** 手动重试：清零退避计数后立即重连（failed / unauthorized 状态下由 UI 调用） */
  retryNow() { this.retry = 0; clearTimeout(this.reconnectTimer); this.connect(); }

  connect() {
    this.closedByUser = false;
    clearTimeout(this.reconnectTimer);
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken())}`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; this.setStatus('open'); this.openListeners.forEach(f => f()); };
    ws.onmessage = (ev) => {
      let frame: any;
      try { frame = JSON.parse(ev.data); } catch { return; }
      if (frame && typeof frame.id === 'string' && 'ok' in frame) {
        const r = frame as ResFrame;
        const p = this.pending.get(r.id);
        if (p) { this.pending.delete(r.id); clearTimeout(p.timer); r.ok ? p.resolve(r.data) : p.reject(new Error(r.error || 'error')); }
        return;
      }
      if (frame && typeof frame.event === 'string') this.listeners.forEach(f => f(frame));
    };
    ws.onclose = () => {
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('连接已断开')); this.pending.delete(id); }
      if (this.closedByUser) { this.setStatus('closed'); return; }
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose 会触发 */ };
  }

  close() { this.closedByUser = true; clearTimeout(this.reconnectTimer); this.ws?.close(); }

  /**
   * 浏览器里握手被 401 拒绝和服务端没起来都只表现为 onclose(1006)，无法区分；
   * 所以重连前先探测一次 REST：401 → token 失效（服务端重启换了 token），停止重连提示用户换链接；
   * 其它错误（连接被拒/超时）→ 继续退避重连；超过 MAX_RETRY 次进入 failed 等手动重试。
   */
  private async scheduleReconnect() {
    this.setStatus('closed');
    try { await api('GET', '/api/bootstrap'); } catch (e: any) {
      if (e instanceof ApiError && e.status === 401) { this.setStatus('unauthorized'); return; }
    }
    if (this.retry >= MAX_RETRY) { this.setStatus('failed'); return; }
    const delay = Math.min(10_000, 500 * 2 ** this.retry++);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private setStatus(s: WsStatus) { this.status = s; this.statusListeners.forEach(f => f(s)); }
  onStatus(f: (s: WsStatus) => void) { this.statusListeners.add(f); return () => this.statusListeners.delete(f); }
  onOpen(f: () => void) { this.openListeners.add(f); return () => this.openListeners.delete(f); }
  onFrame(f: Listener) { this.listeners.add(f); return () => this.listeners.delete(f); }

  /**
   * 未连接时等待连接建立再发（默认 10 秒兜底）：页面刷新时组件挂载常早于 WS 握手完成，
   * 请求排队而非立即失败；token 失效 / 重连放弃 / 主动关闭这三种明确无望的状态立即报错。
   */
  private waitOpen(timeoutMs = 10_000): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.status === 'unauthorized' || this.status === 'failed' || this.closedByUser) return Promise.reject(new Error('未连接到服务端'));
    return new Promise((resolve, reject) => {
      const cleanup = () => { offOpen(); offStatus(); clearTimeout(timer); };
      const timer = window.setTimeout(() => { cleanup(); reject(new Error('未连接到服务端')); }, timeoutMs);
      const offOpen = this.onOpen(() => { cleanup(); resolve(); });
      const offStatus = this.onStatus(s => { if (s === 'unauthorized' || s === 'failed') { cleanup(); reject(new Error('未连接到服务端')); } });
    });
  }

  async request<T = any>(action: string, sessionId?: string, payload?: any, timeoutMs = 120_000): Promise<T> {
    await this.waitOpen();
    const ws = this.ws!;
    const id = `c${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(id); reject(new Error(`请求超时: ${action}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, action, sessionId, payload }));
    });
  }
}

export const wsClient = new WsClient();

/**
 * 终端管理：node-pty 伪终端进程池。
 * 每个终端归属一个会话（cwd = 会话目录），常驻直至显式关闭 / 会话删除 / 服务退出；
 * 保留输出环形缓冲，前端刷新重连时回放。
 */
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import type { IPty } from 'node-pty';
import * as pty from 'node-pty';

/** 回放缓冲上限（字节，按 UTF-8 长度近似） */
const SCROLLBACK_MAX = 200 * 1024;

export interface TermInfo { id: string; sessionId: string; title: string }

interface Term {
  id: string;
  sessionId: string;
  p: IPty;
  buf: string[];
  bufBytes: number;
  exited: boolean;
  listeners: Set<(data: string) => void>;
  exitListeners: Set<(code: number) => void>;
}

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') return { file: 'powershell.exe', args: [] };
  return { file: process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'), args: ['-l'] };
}

/** npm 解包会丢 spawn-helper 的可执行位（node-pty 已知问题），启动前补上 */
function fixSpawnHelper() {
  try {
    const dir = path.join(path.dirname(require.resolve('node-pty/package.json')), 'prebuilds');
    for (const d of fs.readdirSync(dir)) {
      const helper = path.join(dir, d, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  } catch { /* release 构建可能不存在，交给 spawn 时报错 */ }
}
fixSpawnHelper();

export class TerminalManager {
  private terms = new Map<string, Term>();

  create(sessionId: string, cwd: string, cols = 80, rows = 24): TermInfo {
    const id = randomBytes(8).toString('hex');
    const { file, args } = defaultShell();
    const p = pty.spawn(file, args, {
      name: 'xterm-256color',
      cwd: fs.existsSync(cwd) ? cwd : process.cwd(),
      cols, rows,
      env: { ...process.env, TERM_PROGRAM: 'semawork' } as Record<string, string>,
    });
    const term: Term = { id, sessionId, p, buf: [], bufBytes: 0, exited: false, listeners: new Set(), exitListeners: new Set() };
    p.onData(data => {
      term.buf.push(data);
      term.bufBytes += Buffer.byteLength(data);
      while (term.bufBytes > SCROLLBACK_MAX && term.buf.length > 1) term.bufBytes -= Buffer.byteLength(term.buf.shift()!);
      term.listeners.forEach(f => f(data));
    });
    p.onExit(({ exitCode }) => {
      term.exited = true;
      term.exitListeners.forEach(f => f(exitCode));
      // 已退出的终端保留缓冲一段时间由前端展示，不立即删除；连接关闭后由 kill 清理
    });
    this.terms.set(id, term);
    return { id, sessionId, title: path.basename(cwd) || 'shell' };
  }

  get(id: string): { exited: boolean } | null {
    const t = this.terms.get(id);
    return t ? { exited: t.exited } : null;
  }

  /** attach：先回放缓冲，再订阅实时输出；返回取消订阅函数 */
  attach(id: string, onData: (d: string) => void, onExit: (code: number) => void): (() => void) | null {
    const t = this.terms.get(id);
    if (!t) return null;
    if (t.buf.length) onData(t.buf.join(''));
    if (t.exited) { onExit(0); return () => undefined; }
    t.listeners.add(onData);
    t.exitListeners.add(onExit);
    return () => { t.listeners.delete(onData); t.exitListeners.delete(onExit); };
  }

  write(id: string, data: string) { const t = this.terms.get(id); if (t && !t.exited) t.p.write(data); }
  resize(id: string, cols: number, rows: number) {
    const t = this.terms.get(id);
    if (t && !t.exited && cols > 0 && rows > 0) { try { t.p.resize(Math.floor(cols), Math.floor(rows)); } catch { /* race with exit */ } }
  }

  kill(id: string) {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    if (!t.exited) { try { t.p.kill(); } catch { /* already dead */ } }
  }

  killBySession(sessionId: string) {
    for (const [id, t] of this.terms) if (t.sessionId === sessionId) this.kill(id);
  }

  killAll() { for (const id of [...this.terms.keys()]) this.kill(id); }
}

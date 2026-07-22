import type { SemaSession } from 'sema-core';

/**
 * 会话级事件清单（挂在 SemaSession 上，与 VSCode SemaSessionWrapper 转发的事件对齐）。
 * SemaCore.on 只接收进程级事件，会话级事件必须绑在 SemaSession 上。
 */
export const SESSION_EVENTS = [
  'session:ready', 'session:error', 'session:interrupted', 'session:cleared',
  'state:update',
  'input:received', 'input:processing',
  'message:text:chunk', 'message:thinking:chunk', 'message:complete',
  'tool:permission:request', 'tool:permission:auto',
  'tool:execution:complete', 'tool:execution:chunk', 'tool:execution:error',
  'task:agent:start', 'task:agent:end', 'task:start', 'task:end', 'task:transfer',
  'todos:update', 'topic:update',
  'pick:option:request', 'plan:exit:request', 'plan:implement',
  'compact:exec',
  'conversation:usage', 'file:reference',
  'permissionLevel:update', 'quickchat:response',
];

/** 事件推送回调：把会话事件写回对应的 gRPC 流，并带上所属 session_id */
export type EventPush = (event: string, data: any, sessionId: string) => void;

/**
 * 需跨连接广播的会话级生命周期事件：后台任务的 start/transfer/end。
 * 对齐 VSCode handleTaskStart/handleTaskEnd——宿主把任务生命周期同时转发给聊天页与
 * 配置页后台任务面板。JB 各面板连接独立，配置页那条连接没有 session，只能靠广播补齐。
 * （task:transfer 在 VSCode 里也走 onTaskStart，故与 task:start 同列。）
 */
const TASK_BROADCAST_EVENTS = new Set(['task:start', 'task:transfer', 'task:end']);

/**
 * SessionBinder —— 把单个 SemaSession 的会话级事件桥接到 gRPC 流。
 *
 * 每个会话（对应 UI 一个标签）一个实例，转发出去的每条事件都带 session_id，
 * 供宿主按标签分发。对齐 VSCode 中「一个 webview 消息通道按 sessionId 路由多会话」。
 */
export class SessionBinder {
  private handlers: Array<{ event: string; fn: (data: any) => void }> = [];

  constructor(
    public readonly sessionId: string,
    private session: SemaSession,
    private push: EventPush,
    // 跨连接广播（sessionId 留空），用于把后台任务生命周期同步给配置页任务面板；可选以兼容旧调用。
    private broadcast?: (event: string, data: any) => void,
  ) {}

  bind(): void {
    for (const event of SESSION_EVENTS) {
      const fn = (data: any) => {
        this.push(event, data, this.sessionId);
        // 后台任务 start/transfer/end 额外跨连接广播，让配置页任务面板实时增删（D4，对齐 VSCode 双面板转发）。
        // 广播帧 sessionId 留空 → 聊天页当作进程级事件、其 onProcessEvent 只认 model:update 故天然忽略，不会重复投递。
        if (this.broadcast && TASK_BROADCAST_EVENTS.has(event)) this.broadcast(event, data);
      };
      (this.session as any).on(event, fn);
      this.handlers.push({ event, fn });
    }
  }

  unbind(): void {
    for (const { event, fn } of this.handlers) {
      try { (this.session as any).off?.(event, fn); } catch { /* ignore */ }
    }
    this.handlers = [];
  }
}

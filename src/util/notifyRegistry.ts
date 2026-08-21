/** 通知回调：向某个会话推送一条消息；display 为 UI 气泡展示用的干净文本（缺省不展示或展示 msg，由注册方决定） */
export type NotifyCallback = (msg: string, opts?: { display?: string }) => void

/**
 * 按 sessionId 注册/查询通知回调的注册表。
 * 供 CronManager / TaskManager 复用，避免各自重复实现回调 Map。
 */
export class SessionNotifyRegistry {
  private callbacks = new Map<string, NotifyCallback>()

  set(sessionId: string, cb: NotifyCallback): void {
    this.callbacks.set(sessionId, cb)
  }

  remove(sessionId: string): void {
    this.callbacks.delete(sessionId)
  }

  get(sessionId: string): NotifyCallback | undefined {
    return this.callbacks.get(sessionId)
  }

  /** 取任意一个已注册回调，用于兜底投递 */
  getAny(): { sessionId: string; cb: NotifyCallback } | null {
    const first = this.callbacks.entries().next()
    return first.done ? null : { sessionId: first.value[0], cb: first.value[1] }
  }
}

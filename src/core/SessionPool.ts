import { CreateSessionOptions, CreateSessionResult } from '../types/session';
import { SemaSession } from './SemaSession';
import { getConfManager } from '../manager/ConfManager';
import { getCronManager } from '../manager/CronManager';
import { getStateManager } from '../manager/StateManager';
import { logWarn } from '../util/log';

/**
 * 会话池 - 管理多会话的创建、查找与销毁。
 * 进程级单例，由 SemaCore 委托使用。
 */
class SessionPool {
  private readonly sessions = new Map<string, SemaSession>();

  /**
   * 创建会话，返回 SemaSession。
   * 超过 maxSessions 限制时返回 { ok: false, error }，不抛异常。
   */
  createSession = async (opts: CreateSessionOptions = {}): Promise<CreateSessionResult> => {
    const maxSessions = getConfManager().getCoreConfig()?.maxSessions;
    // 复用已存在会话（同 sessionId 重复 createSession）
    if (opts.sessionId && this.sessions.has(opts.sessionId)) {
      return { ok: true, session: this.sessions.get(opts.sessionId)! };
    }
    if (typeof maxSessions === 'number' && this.sessions.size >= maxSessions) {
      const error = `已达到会话数量上限 (${maxSessions})，请先关闭已有会话`;
      logWarn(error);
      return { ok: false, error };
    }

    try {
      const session = await SemaSession.create(opts);
      this.sessions.set(session.sessionId, session);
      // 尚无活跃会话时，新建会话即设为活跃（单会话场景下 UI 无需关心）
      if (!getStateManager().getActiveSessionId()) {
        getStateManager().setActiveSession(session.sessionId);
      }
      return { ok: true, session };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `会话初始化失败: ${msg}` };
    }
  };

  /** 获取已存在的会话 */
  getSession = (sessionId: string): SemaSession | undefined => this.sessions.get(sessionId);

  /** 列出所有会话 ID */
  listSessions = (): string[] => Array.from(this.sessions.keys());

  /**
   * 设置 UI 当前活跃会话（切换会话时调用）。
   * 多会话共存时，定时任务在来源会话已关闭的情况下会兜底投递到活跃会话。
   * sessionId 不在会话池中返回 false。
   */
  setActiveSession = (sessionId: string): boolean => {
    if (!this.sessions.has(sessionId)) return false;
    getStateManager().setActiveSession(sessionId);
    return true;
  };

  /** 关闭并销毁指定会话 */
  closeSession = (sessionId: string): boolean => {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.dispose();
    this.sessions.delete(sessionId);
    // 清理该会话创建的非持久 cron 任务
    getCronManager().clearNonDurableTasks(sessionId);
    return true;
  };

  /** 关闭并清空所有会话（进程级 dispose 调用，不触碰其它全局单例） */
  disposeAll = (): void => {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  };
}

let globalSessionPool: SessionPool | null = null;

/** 获取全局 SessionPool 实例（单例模式） */
export const getSessionPool = (): SessionPool => {
  if (!globalSessionPool) {
    globalSessionPool = new SessionPool();
  }
  return globalSessionPool;
};

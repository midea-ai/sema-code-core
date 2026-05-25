import type { AgentMode, PermissionLevel } from './index';
import type { SemaSession } from '../core/SemaSession';

/** 创建会话的可选项 */
export interface CreateSessionOptions {
  /** 已存在的会话ID（加载历史），不传则新建会话 */
  sessionId?: string;
  /** 会话初始 Agent 模式，不传则取全局默认 */
  agentMode?: AgentMode;
  /** 会话初始权限自由度档位，不传则默认 'Ask' */
  permissionLevel?: PermissionLevel;
}

/** 创建会话的结果（超限等失败场景返回明确错误，不抛异常） */
export type CreateSessionResult =
  | { ok: true; session: SemaSession }
  | { ok: false; error: string };

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
  /**
   * 会话级主要模型（profile 名，同 switchModel 参数格式 modelName[provider]），仅本会话生效、不持久化。
   * 不传时钉住创建时刻的全局 main 指针，之后全局 switchModel/applyTaskModel 不影响本会话；
   * 创建后可用 SemaSession.switchModel 改本会话的主模型。
   */
  mainModel?: string;
  /** 会话级快速模型，仅本会话生效、不持久化；不传沿用全局 quick 指针（不钉住，跟随全局变化） */
  quickModel?: string;
}

/** 创建会话的结果（超限等失败场景返回明确错误，不抛异常） */
export type CreateSessionResult =
  | { ok: true; session: SemaSession }
  | { ok: false; error: string };

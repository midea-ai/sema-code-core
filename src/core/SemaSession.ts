import { SemaEngine } from './SemaEngine';
import { CreateSessionOptions } from '../types/session';
import { ForkOptions, ForkPreview, ForkResult } from '../types/fork';
import { SessionEventBus, createSessionEventBus } from '../events/EventSystem';
import { generateSessionId } from '../util/session';
import { getStateManager } from '../manager/StateManager';
import { getCheckpointManager } from '../manager/CheckpointManager';
import { getTaskManager } from '../manager/TaskManager';
import { ToolPermissionResponse, PickOptionResponseData, PlanExitResponseData } from '../events/types';
import { TaskListItem } from '../types/task';
import type { AgentMode, PermissionLevel } from '../types';
import type { InputImageAttachment } from '../types/message';
import { logInfo } from '../util/log';

/**
 * 会话级 API
 * 由 SemaCore.createSession() 创建并返回，承载单个会话的全部交互能力。
 * 进程级能力（模型/MCP/插件/agents 配置）仍在 SemaCore 上。
 */
export class SemaSession {
  constructor(
    public readonly sessionId: string,
    private readonly engine: SemaEngine,
    private readonly bus: SessionEventBus,
  ) {}

  /**
   * 创建并初始化一个会话：装配事件总线、引擎与会话对象。
   * 初始化失败时自动清理并向上抛出异常，由调用方决定如何处理。
   */
  static async create(opts: CreateSessionOptions = {}): Promise<SemaSession> {
    const sessionId = opts.sessionId || generateSessionId();
    const bus = createSessionEventBus(sessionId);
    const engine = new SemaEngine(sessionId, bus);
    const session = new SemaSession(sessionId, engine, bus);

    try {
      await engine.createSession({ sessionId: opts.sessionId, agentMode: opts.agentMode });
    } catch (error) {
      session.dispose();
      throw error;
    }

    return session;
  }

  // ==================== 事件接口（仅本会话）====================
  on = <T>(event: string, listener: (data: T) => void) => (this.bus.on(event, listener), this);
  once = <T>(event: string, listener: (data: T) => void) => (this.bus.once(event, listener), this);
  off = <T>(event: string, listener: (data: T) => void) => (this.bus.off(event, listener), this);

  // 权限/交互响应接口
  respondToToolPermission = (response: ToolPermissionResponse) =>
    this.bus.emit('tool:permission:response', response);
  respondToPickOption = (response: PickOptionResponseData) =>
    this.bus.emit('pick:option:response', response);
  respondToPlanExit = (response: PlanExitResponseData) =>
    this.bus.emit('plan:exit:response', response);

  // ==================== 会话交互 ====================
  processUserInput = (input: string, originalInput?: string, attachments?: InputImageAttachment[]): void =>
    this.engine.processUserInput(input, originalInput, false, attachments);

  interrupt = (): void => this.engine.interruptSession();

  // ==================== 会话级配置 ====================
  updateAgentMode = (mode: AgentMode): void => this.engine.updateAgentMode(mode);
  updatePermissionLevel = (level: PermissionLevel): void => this.engine.updatePermissionLevel(level);

  // ==================== 会话 Fork / 撤销 ====================
  /** 预览：在该用户消息处恢复文件会改动哪些文件、各自增删行数（只读，无副作用） */
  getForkPreview = (messageUuid: string): ForkPreview =>
    getCheckpointManager().preview(this.sessionId, messageUuid);

  /**
   * 原地回退（Fork / 撤销）：把会话历史截断到该用户消息之前；
   * restoreFiles=true 时同时回滚文件。会话 id 不变，继续使用。
   */
  fork = (messageUuid: string, options?: ForkOptions): Promise<ForkResult> =>
    this.engine.rewind(messageUuid, options);

  // ==================== 后台任务（仅本会话）====================
  getTaskList = (): TaskListItem[] => getTaskManager().getTaskList(this.sessionId);
  watchTask = (taskId: string, onDelta: (delta: string) => void): () => void =>
    getTaskManager().watchTask(taskId, onDelta);
  stopTask = (taskId: string): boolean => getTaskManager().stopTask(taskId);
  stopAllTasks = (): number => getTaskManager().stopAllTasks(this.sessionId);
  transferAgentToBackground = (taskId: string): boolean => getTaskManager().transferToBackground(taskId);
  transferAllForegroundAgents = (): string[] => getTaskManager().transferAllForeground(this.sessionId);

  /**
   * 关闭会话（会话级 dispose，不触碰全局单例）
   */
  dispose = (): void => {
    logInfo(`关闭会话: ${this.sessionId}`);
    this.engine.dispose();
    getTaskManager().disposeSession(this.sessionId);
    getStateManager().removeSession(this.sessionId);
    getCheckpointManager().forgetSession(this.sessionId);
    this.bus.dispose();
  };
}


/**
 * 子代理不触发 conversation:usage、message:chunk、state:update、todos:update、topic:update
 * 子代理相关事件 message:complete、tool:execution:complete、tool:execution:error、session:interrupted、tool:permission:request 有agentId字段
 */

import { getEventBus } from '../events/EventSystem';
import { StateUpdateData, SessionState, TodoItem } from '../events/types';
import { logInfo } from '../util/log';
import { saveHistory } from '../util/history';
import { Message } from '../types/message';
import { getConfManager } from './ConfManager';

// 扩展 TodoItem，添加可选的 id 字段（用于智能更新）
export interface TodoItemWithId extends TodoItem {
  id?: string;
}

// 代理状态接口
interface AgentState {
  currentState: SessionState;
  previousState: SessionState;
}

// 主代理固定 ID
export const MAIN_AGENT_ID = 'main';

/**
 * 代理状态访问接口
 * 封装对特定 agentId 的所有状态访问
 */
export interface AgentStateAccessor {
  // Todos 管理
  getTodos(): TodoItemWithId[];
  setTodos(todos: TodoItemWithId[]): void;
  updateTodosIntelligently(todos: TodoItemWithId[]): void;
  clearTodos(): void;

  // 消息历史管理
  getMessageHistory(): Message[];
  setMessageHistory(messages: Message[]): void;
  finalizeMessages(messages: Message[]): void;

  // 文件读取时间戳管理
  getReadFileTimestamps(): Record<string, number>;
  getReadFileTimestamp(filePath: string): number | undefined;
  setReadFileTimestamp(filePath: string, timestamp: number): void;

  // 状态管理
  getCurrentState(): SessionState;
  updateState(state: SessionState): void;

  // 清理
  clearAllState(): void;
}

/**
 * 全局状态管理器
 * 负责管理会话状态并发送状态更新事件
 *
 * 隔离状态（按 agentId）：
 * - statesMap: 代理状态 (currentState/previousState)
 * - messageHistoryMap: 消息历史
 * - readFileTimestampsMap: 文件读取时间戳
 * - todosMap: todos 列表
 *
 * 共享状态：
 * - sessionId: 会话ID
 * - globalEditPermissionGranted: 全局编辑权限
 * - currentAbortController: 中断控制器
 */
export class StateManager {
  private static instance: StateManager | null = null;

  // === 隔离状态（按 agentId） ===
  private statesMap: Map<string, AgentState> = new Map();
  private messageHistoryMap: Map<string, Message[]> = new Map();
  private readFileTimestampsMap: Map<string, Record<string, number>> = new Map();
  private todosMap: Map<string, TodoItemWithId[]> = new Map();

  // === 共享状态 ===
  private sessionId: string | null = null;
  private globalEditPermissionGranted = false;
  private planModeInfoSent = false;
  public currentAbortController: AbortController | null = null;

  private constructor() {
    // 私有构造函数，确保单例模式
  }

  /**
   * 获取StateManager实例（单例模式）
   */
  static getInstance(): StateManager {
    if (!StateManager.instance) {
      StateManager.instance = new StateManager();
    }
    return StateManager.instance;
  }

  /**
   * 获取当前会话ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * 设置会话ID
   */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
    // 新建会话时重置全局编辑权限
    this.globalEditPermissionGranted = false;
    logInfo(`会话ID已设置: ${sessionId}，全局编辑权限已重置`);
  }

  // ============================================================
  // 消息历史管理（按代理隔离）
  // ============================================================

  /**
   * 设置消息历史
   */
  setMessageHistory(messages: Message[], agentId: string = MAIN_AGENT_ID): void {
    this.messageHistoryMap.set(agentId, messages);
    // 主代理设置消息历史时自动保存
    if (agentId === MAIN_AGENT_ID && this.sessionId && messages.length > 0) {
      this.saveSessionHistory();
    }
  }

  /**
   * 获取消息历史
   */
  getMessageHistory(agentId: string = MAIN_AGENT_ID): Message[] {
    return this.messageHistoryMap.get(agentId) || [];
  }

  // ============================================================
  // 文件读取时间戳管理（按代理隔离）
  // ============================================================

  /**
   * 获取文件读取时间戳
   */
  getReadFileTimestamps(agentId: string = MAIN_AGENT_ID): Record<string, number> {
    let timestamps = this.readFileTimestampsMap.get(agentId);
    if (!timestamps) {
      timestamps = {};
      this.readFileTimestampsMap.set(agentId, timestamps);
    }
    return timestamps;
  }

  /**
   * 设置单个文件的读取时间戳
   */
  setReadFileTimestamp(filePath: string, timestamp: number, agentId: string = MAIN_AGENT_ID): void {
    const timestamps = this.getReadFileTimestamps(agentId);
    timestamps[filePath] = timestamp;
  }

  /**
   * 获取单个文件的读取时间戳
   */
  getReadFileTimestamp(filePath: string, agentId: string = MAIN_AGENT_ID): number | undefined {
    return this.getReadFileTimestamps(agentId)[filePath];
  }

  // ============================================================
  // todos 管理（按代理隔离）
  // ============================================================

  /**
   * 获取 todos 列表
   */
  getTodos(agentId: string = MAIN_AGENT_ID): TodoItemWithId[] {
    return this.todosMap.get(agentId) || [];
  }

  /**
   * 设置 todos 列表
   */
  setTodos(todos: TodoItemWithId[], agentId: string = MAIN_AGENT_ID): void {
    this.todosMap.set(agentId, todos);
  }

  /**
   * 清理指定代理的 todos
   */
  clearAgentTodos(agentId: string): void {
    if (agentId !== MAIN_AGENT_ID) {
      this.todosMap.delete(agentId);
      logInfo(`[${agentId}] todos已清理`);
    }
  }

  /**
   * 智能更新 todos 列表
   * 如果传入的 todos 都有 id 且是现有 todos 的子集，则进行子集更新，否则进行完全替换
   */
  updateTodosIntelligently(newTodos: TodoItemWithId[], agentId: string = MAIN_AGENT_ID): void {
    const currentTodos = this.todosMap.get(agentId) || [];

    if (newTodos.length === 0) {
      // 空数组直接替换
      this.todosMap.set(agentId, newTodos);
      logInfo(`[${agentId}] todos完全替换: ${newTodos.length} 项`);
      // 只有主代理才发送事件
      if (agentId === MAIN_AGENT_ID) {
        this.emitTodosUpdateEvent(newTodos);
      }
      return;
    }

    // 检查是否为子集更新
    const isSubsetUpdate = newTodos.every(todo =>
      todo.id && currentTodos.some(existing => existing.id === todo.id)
    );

    if (isSubsetUpdate && currentTodos.length > 0) {
      // 子集更新：更新现有 todos 中匹配的项
      const updatedTodos = currentTodos.map(existing => {
        const update = newTodos.find(todo => todo.id === existing.id);
        return update || existing;
      });
      this.todosMap.set(agentId, updatedTodos);
      logInfo(`[${agentId}] todos子集更新: ${newTodos.length} 项更新，总共 ${updatedTodos.length} 项`);
      // 只有主代理才发送事件
      if (agentId === MAIN_AGENT_ID) {
        this.emitTodosUpdateEvent(newTodos);
      }
    } else {
      // 完全替换：有新的 id 或没有 id 的情况
      this.todosMap.set(agentId, newTodos);
      logInfo(`[${agentId}] todos完全替换: ${newTodos.length} 项`);
      // 只有主代理才发送事件
      if (agentId === MAIN_AGENT_ID) {
        this.emitTodosUpdateEvent(newTodos);
      }
    }
  }

  /**
   * 发送 todos 更新事件
   */
  private emitTodosUpdateEvent(todos: TodoItemWithId[]): void {
    const eventBus = getEventBus();
    eventBus.emit('todos:update', todos);
  }

  // ============================================================
  // 代理状态管理（按代理隔离）
  // ============================================================

  /**
   * 获取代理状态
   */
  private getAgentState(agentId: string): AgentState {
    let state = this.statesMap.get(agentId);
    if (!state) {
      state = { currentState: 'idle', previousState: 'idle' };
      this.statesMap.set(agentId, state);
    }
    return state;
  }

  /**
   * 更新状态并发送事件
   * - 只有主代理 (agentId === MAIN_AGENT_ID) 才会发送全局状态事件
   */
  updateState(newState: SessionState, agentId: string = MAIN_AGENT_ID): void {
    const agentState = this.getAgentState(agentId);

    // 添加调试日志
    logInfo(`updateState: agentId=${agentId}, current=${agentState.currentState}, new=${newState}, sessionId=${this.sessionId}`);

    if (agentState.currentState !== newState) {
      agentState.previousState = agentState.currentState;
      agentState.currentState = newState;

      // 只有主代理才发送全局状态更新事件（直接使用 eventBus，参见方法注释）
      if (agentId === MAIN_AGENT_ID) {
        const eventBus = getEventBus();
        const stateData: StateUpdateData = {
          state: newState
        };
        eventBus.emit('state:update', stateData);

        logInfo(`状态更新: ${agentState.previousState} → ${newState}`);
      } else {
        logInfo(`[${agentId}] 状态更新: ${agentState.previousState} → ${newState}`);
      }
    } else {
      logInfo(`updateState: 状态未变化`);
    }
  }

  /**
   * 获取当前状态
   */
  getCurrentState(agentId: string = MAIN_AGENT_ID): SessionState {
    return this.getAgentState(agentId).currentState;
  }

  /**
   * 清空所有状态数据
   */
  clearAllState(): void {
    // 清空所有隔离状态的 Map
    this.statesMap.clear();
    this.messageHistoryMap.clear();
    this.readFileTimestampsMap.clear();
    this.todosMap.clear();

    // 重置共享状态
    this.currentAbortController = null;
    this.globalEditPermissionGranted = false;
    this.planModeInfoSent = false;

    logInfo('所有状态数据已清空');
  }

  /**
   * 清理指定代理的所有隔离状态
   */
  clearAgentState(agentId: string): void {
    if (agentId !== MAIN_AGENT_ID) {
      this.statesMap.delete(agentId);
      this.messageHistoryMap.delete(agentId);
      this.readFileTimestampsMap.delete(agentId);
      this.todosMap.delete(agentId);
      logInfo(`[${agentId}] 所有隔离状态已清理`);
    }
  }

  /**
   * 保存会话历史到文件
   */
  private async saveSessionHistory(): Promise<void> {
    try {
      const messageHistory = this.getMessageHistory();
      const todos = this.getTodos();
      const workingDir = getConfManager().getCoreConfig()?.workingDir;
      if (this.sessionId && messageHistory.length > 0) {
        await saveHistory(this.sessionId, messageHistory, todos, workingDir);
        // logInfo(`saveHistory: ${JSON.stringify(messageHistory, null, 2)}`)

        logInfo(`会话历史已保存: ${this.sessionId}`);
      }
    } catch (error) {
      logInfo(`保存会话历史失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 获取全局编辑权限状态
   */
  hasGlobalEditPermission(): boolean {
    return this.globalEditPermissionGranted;
  }

  /**
   * 授予全局编辑权限
   */
  grantGlobalEditPermission(): void {
    this.globalEditPermissionGranted = true;
    logInfo('全局编辑权限已授予');
  }

  /**
   * 检查 Plan 模式信息是否已发送
   */
  isPlanModeInfoSent(): boolean {
    return this.planModeInfoSent;
  }

  /**
   * 标记 Plan 模式信息已发送
   */
  markPlanModeInfoSent(): void {
    this.planModeInfoSent = true;
    logInfo('Plan 模式信息已标记为已发送');
  }

  /**
   * 重置 Plan 模式信息发送状态
   */
  resetPlanModeInfoSent(): void {
    this.planModeInfoSent = false;
    logInfo('Plan 模式信息发送状态已重置');
  }

  /**
   * 为指定 agentId 创建状态访问代理对象
   * 返回一个封装了该 agentId 所有状态操作的对象
   */
  forAgent(agentId: string): AgentStateAccessor {
    const isSubagent = agentId !== MAIN_AGENT_ID;

    return {
      // Todos 管理
      getTodos: () => this.getTodos(agentId),
      setTodos: (todos: TodoItemWithId[]) => this.setTodos(todos, agentId),
      updateTodosIntelligently: (todos: TodoItemWithId[]) => this.updateTodosIntelligently(todos, agentId),
      clearTodos: () => {
        if (isSubagent) {
          this.clearAgentTodos(agentId);
        }
      },

      // 消息历史管理
      getMessageHistory: () => this.getMessageHistory(agentId),
      setMessageHistory: (messages: Message[]) => this.setMessageHistory(messages, agentId),
      finalizeMessages: (messages: Message[]) => {
        this.setMessageHistory(messages, agentId);
        this.updateState('idle', agentId);
      },

      // 文件读取时间戳管理
      getReadFileTimestamps: () => this.getReadFileTimestamps(agentId),
      getReadFileTimestamp: (filePath: string) => this.getReadFileTimestamp(filePath, agentId),
      setReadFileTimestamp: (filePath: string, timestamp: number) => this.setReadFileTimestamp(filePath, timestamp, agentId),

      // 状态管理
      getCurrentState: () => this.getCurrentState(agentId),
      updateState: (state: SessionState) => this.updateState(state, agentId),

      // 清理
      clearAllState: () => {
        if (isSubagent) {
          this.clearAgentState(agentId);
        }
      },
    };
  }

}

/**
 * 获取 StateManager 单例实例
 */
export const getStateManager = () => StateManager.getInstance();

/**
 * 子代理不触发 conversation:usage、message:chunk、tool:execution:chunk、state:update、todos:update、topic:update
 * 子代理相关事件 message:complete、tool:execution:complete、tool:execution:error、session:interrupted、tool:permission:request 有agentId字段
 */

import * as crypto from 'crypto';
import { getEventBus } from '../events/EventSystem';
import { StateUpdateData, AppSessionState, TodoItem, AutoEditUpdateData } from '../events/types';
import { logInfo } from '../util/log';
import { saveHistory } from '../util/history';
import { Message } from '../types/message';
import { getConfManager } from './ConfManager';
import { TodoTask, TodoTaskStatus } from '../types/todoTask';
import { LineEndingKind } from '../util/file';


// 待处理用户输入项
export interface PendingUserInput {
  inputId: string;
  input: string;
  originalInput?: string;
  silent?: boolean;
  type: 'inject' | 'command'; // inject=普通文本，command=以/开头的命令
}

// 代理状态接口
interface AgentState {
  currentState: AppSessionState;
  previousState: AppSessionState;
}

// 主代理固定 ID
export const MAIN_AGENT_ID = 'main';

/**
 * 代理状态访问接口
 * 封装对特定 agentId 的所有状态访问
 */
export interface AgentStateAccessor {
  // Todos 管理
  getTodos(): TodoItem[];
  setTodos(todos: TodoItem[]): void;
  updateTodosIntelligently(todos: TodoItem[]): void;
  clearTodos(): void;

  // 消息历史管理
  getMessageHistory(): Message[];
  setMessageHistory(messages: Message[], skipAutoSave?: boolean): void;
  finalizeMessages(messages: Message[]): void;
  flushHistory(): Promise<void>;

  // 文件读取时间戳批量设置
  setReadFileTimestamps(timestamps: Record<string, number>): void;

  // 文件读取时间戳管理
  getReadFileTimestamps(): Record<string, number>;
  getReadFileTimestamp(filePath: string): number | undefined;
  setReadFileTimestamp(filePath: string, timestamp: number): void;

  // 文件换行符缓存
  getFileLineEnding(filePath: string): LineEndingKind | undefined;
  setFileLineEnding(filePath: string, ending: LineEndingKind): void;

  // 状态管理
  getCurrentState(): AppSessionState;
  updateState(state: AppSessionState): void;

  // TodoTask CRUD
  createTodoTask(task: Omit<TodoTask, 'id' | 'createdAt' | 'updatedAt'>): string;
  getTodoTask(taskId: string): TodoTask | undefined;
  listTodoTasks(): TodoTask[];
  updateTodoTask(taskId: string, updates: Partial<Pick<TodoTask, 'title' | 'description' | 'status' | 'progressText'>>): TodoTask | undefined;
  deleteTodoTask(taskId: string): boolean;
  blockTask(fromId: string, toId: string): boolean;

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
  private todosMap: Map<string, TodoItem[]> = new Map();
  private todoTasksMap: Map<string, TodoTask[]> = new Map();
  private fileLineEndingsMap: Map<string, Record<string, LineEndingKind>> = new Map();

  // === 共享状态 ===
  private sessionId: string | null = null;
  private globalEditPermissionGranted = false;
  private planModeInfoSent = false;
  private designModeInfoSent = false;
  public currentAbortController: AbortController | null = null;

  // 当前正在运行的前台 agent taskId 集合
  private foregroundAgents = new Set<string>();

  // 待处理用户输入队列（共享状态）
  private pendingUserInputs: PendingUserInput[] = [];

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
  setMessageHistory(messages: Message[], agentId: string = MAIN_AGENT_ID, skipAutoSave = false): void {
    this.messageHistoryMap.set(agentId, messages);
    // 主代理设置消息历史时自动保存
    if (!skipAutoSave && agentId === MAIN_AGENT_ID && this.sessionId && messages.length > 0) {
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
   * 批量设置文件读取时间戳（覆盖）
   */
  setReadFileTimestamps(timestamps: Record<string, number>, agentId: string = MAIN_AGENT_ID): void {
    this.readFileTimestampsMap.set(agentId, { ...timestamps });
  }

  /**
   * 获取单个文件的读取时间戳
   */
  getReadFileTimestamp(filePath: string, agentId: string = MAIN_AGENT_ID): number | undefined {
    return this.getReadFileTimestamps(agentId)[filePath];
  }

  // ============================================================
  // 文件换行符缓存（按代理隔离）
  // ============================================================

  /**
   * 获取缓存的文件换行符类型
   */
  getFileLineEnding(filePath: string, agentId: string = MAIN_AGENT_ID): LineEndingKind | undefined {
    return this.fileLineEndingsMap.get(agentId)?.[filePath];
  }

  /**
   * 缓存文件的换行符类型
   */
  setFileLineEnding(filePath: string, ending: LineEndingKind, agentId: string = MAIN_AGENT_ID): void {
    let endings = this.fileLineEndingsMap.get(agentId);
    if (!endings) {
      endings = {};
      this.fileLineEndingsMap.set(agentId, endings);
    }
    endings[filePath] = ending;
  }

  // ============================================================
  // todos 管理（按代理隔离）
  // ============================================================

  /**
   * 获取 todos 列表
   */
  getTodos(agentId: string = MAIN_AGENT_ID): TodoItem[] {
    return this.todosMap.get(agentId) || [];
  }

  /**
   * 设置 todos 列表
   */
  setTodos(todos: TodoItem[], agentId: string = MAIN_AGENT_ID): void {
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
  updateTodosIntelligently(newTodos: TodoItem[], agentId: string = MAIN_AGENT_ID): void {
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
  private emitTodosUpdateEvent(todos: TodoItem[]): void {
    const eventBus = getEventBus();
    eventBus.emit('todos:update', todos);
  }

  // ============================================================
  // TodoTask CRUD（按代理隔离）
  // ============================================================

  private getTodoTasks(agentId: string): TodoTask[] {
    let tasks = this.todoTasksMap.get(agentId);
    if (!tasks) {
      tasks = [];
      this.todoTasksMap.set(agentId, tasks);
    }
    return tasks;
  }

  createTodoTask(agentId: string, task: Omit<TodoTask, 'id' | 'createdAt' | 'updatedAt'>): string {
    const tasks = this.getTodoTasks(agentId);
    // 递增数字编号：取当前最大 id + 1
    const maxId = tasks.reduce((max, t) => Math.max(max, parseInt(t.id, 10) || 0), 0);
    const id = String(maxId + 1);
    const now = Date.now();
    const newTask: TodoTask = {
      ...task,
      blocks: task.blocks ?? [],
      blockedBy: task.blockedBy ?? [],
      id,
      createdAt: now,
      updatedAt: now,
    };
    tasks.push(newTask);
    logInfo(`[${agentId}] TodoTask created: ${id} "${task.title}"`);
    this.syncTodoTasksToTodos(agentId);
    return id;
  }

  getTodoTask(agentId: string, taskId: string): TodoTask | undefined {
    return this.getTodoTasks(agentId).find(t => t.id === taskId);
  }

  listTodoTasks(agentId: string): TodoTask[] {
    return this.getTodoTasks(agentId);
  }

  updateTodoTask(
    agentId: string,
    taskId: string,
    updates: Partial<Pick<TodoTask, 'title' | 'description' | 'status' | 'progressText'>>,
  ): TodoTask | undefined {
    const tasks = this.getTodoTasks(agentId);
    const task = tasks.find(t => t.id === taskId);
    if (!task) return undefined;

    if (updates.title !== undefined) task.title = updates.title;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.progressText !== undefined) task.progressText = updates.progressText;
    task.updatedAt = Date.now();
    logInfo(`[${agentId}] TodoTask updated: ${taskId} fields=[${Object.keys(updates).join(',')}]`);
    this.syncTodoTasksToTodos(agentId);
    return task;
  }

  deleteTodoTask(agentId: string, taskId: string): boolean {
    const tasks = this.getTodoTasks(agentId);
    const idx = tasks.findIndex(t => t.id === taskId);
    if (idx === -1) return false;
    tasks.splice(idx, 1);
    // 清理其他任务中对被删任务的引用
    for (const t of tasks) {
      t.blocks = t.blocks.filter(id => id !== taskId);
      t.blockedBy = t.blockedBy.filter(id => id !== taskId);
    }
    logInfo(`[${agentId}] TodoTask deleted: ${taskId}`);
    this.syncTodoTasksToTodos(agentId);
    return true;
  }

  /**
   * 建立阻塞关系：fromId 阻塞 toId（toId 需等待 fromId 完成）
   * 双向写入保持一致性
   */
  blockTask(agentId: string, fromId: string, toId: string): boolean {
    const tasks = this.getTodoTasks(agentId);
    const fromTask = tasks.find(t => t.id === fromId);
    const toTask = tasks.find(t => t.id === toId);
    if (!fromTask || !toTask) return false;

    // 去重追加
    if (!fromTask.blocks.includes(toId)) {
      fromTask.blocks.push(toId);
      fromTask.updatedAt = Date.now();
    }
    if (!toTask.blockedBy.includes(fromId)) {
      toTask.blockedBy.push(fromId);
      toTask.updatedAt = Date.now();
    }
    logInfo(`[${agentId}] TodoTask block: #${fromId} blocks #${toId}`);
    this.syncTodoTasksToTodos(agentId);
    return true;
  }

  /**
   * 从持久化数据恢复 TodoTask 列表（主代理）
   */
  restoreTodoTasks(tasks: TodoTask[]): void {
    // 兼容旧数据：补充 blocks/blockedBy 默认值
    const normalized = tasks.map(t => ({
      ...t,
      blocks: t.blocks ?? [],
      blockedBy: t.blockedBy ?? [],
    }));
    this.todoTasksMap.set(MAIN_AGENT_ID, normalized);
    logInfo(`TodoTasks restored: ${tasks.length} 项`);
  }

  /**
   * 从旧版 TodoItem 格式恢复为 TodoTask（兼容旧历史数据）
   */
  restoreTodoTasksFromLegacy(todos: TodoItem[]): void {
    const now = Date.now();
    const tasks: TodoTask[] = todos.map((todo, index) => ({
      id: todo.id || crypto.randomBytes(4).toString('hex'),
      title: todo.title,
      description: todo.title,
      status: todo.status as TodoTaskStatus,
      progressText: todo.progressText || todo.title,
      blocks: [],
      blockedBy: [],
      createdAt: now,
      updatedAt: now,
    }));
    this.todoTasksMap.set(MAIN_AGENT_ID, tasks);
    logInfo(`TodoTasks restored from legacy todos: ${tasks.length} 项`);
  }

  /**
   * 将 TodoTask 列表同步到 todosMap 并触发 UI 更新事件
   */
  private syncTodoTasksToTodos(agentId: string): void {
    const tasks = this.getTodoTasks(agentId);

    // 排序：completed > in_progress > pending；pending 中被阻塞的排最后
    const statusOrder: Record<string, number> = { completed: 0, in_progress: 1, pending: 2 };
    const completedIds = new Set(tasks.filter(t => t.status === 'completed').map(t => t.id));

    const sorted = [...tasks].sort((a, b) => {
      const oa = statusOrder[a.status] ?? 3;
      const ob = statusOrder[b.status] ?? 3;
      if (oa !== ob) return oa - ob;
      // 同为 pending 时，被阻塞（且阻塞者未完成）的排后面
      if (a.status === 'pending' && b.status === 'pending') {
        const aBlocked = a.blockedBy.some(id => !completedIds.has(id));
        const bBlocked = b.blockedBy.some(id => !completedIds.has(id));
        if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
      }
      return 0;
    });

    const todos: TodoItem[] = sorted.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      progressText: t.progressText || t.title,
    }));
    this.todosMap.set(agentId, todos);
    if (agentId === MAIN_AGENT_ID) {
      this.emitTodosUpdateEvent(todos);
    }
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
  updateState(newState: AppSessionState, agentId: string = MAIN_AGENT_ID): void {
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
  getCurrentState(agentId: string = MAIN_AGENT_ID): AppSessionState {
    return this.getAgentState(agentId).currentState;
  }

  // ============================================================
  // 前台 Agent 管理（共享状态）
  // ============================================================

  addForegroundAgent(taskId: string): void {
    this.foregroundAgents.add(taskId);
  }

  removeForegroundAgent(taskId: string): void {
    this.foregroundAgents.delete(taskId);
  }

  getForegroundAgentIds(): string[] {
    return Array.from(this.foregroundAgents);
  }

  clearForegroundAgents(): void {
    this.foregroundAgents.clear();
  }

  // ============================================================
  // 待处理用户输入队列管理（共享状态）
  // ============================================================

  /**
   * 添加待处理输入到队列末尾
   */
  addPendingUserInput(item: PendingUserInput): void {
    this.pendingUserInputs.push(item);
  }

  /**
   * 获取待处理输入队列长度
   */
  getPendingUserInputsLength(): number {
    return this.pendingUserInputs.length;
  }

  /**
   * 从队头连续取 inject 类型，遇到 command 停止
   * 取出的从队列移除，command 及之后保留
   */
  consumeInjectInputsBeforeNextCommand(): PendingUserInput[] {
    const result: PendingUserInput[] = [];
    while (
      this.pendingUserInputs.length > 0 &&
      this.pendingUserInputs[0].type === 'inject'
    ) {
      result.push(this.pendingUserInputs.shift()!);
    }
    return result;
  }

  /**
   * 消费全部剩余输入并清空队列
   */
  consumeAllPendingInputs(): PendingUserInput[] {
    return this.pendingUserInputs.splice(0);
  }

  /**
   * 清空待处理输入队列
   */
  clearPendingUserInputs(): void {
    this.pendingUserInputs = [];
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
    this.todoTasksMap.clear();

    // 重置共享状态
    this.currentAbortController = null;
    this.globalEditPermissionGranted = false;
    this.planModeInfoSent = false;
    this.designModeInfoSent = false;
    this.foregroundAgents.clear();
    this.clearPendingUserInputs();

    logInfo(`所有状态数据已清空`);
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
      this.todoTasksMap.delete(agentId);
      logInfo(`[${agentId}] 所有隔离状态已清理`);
    }
  }

  /**
   * 保存会话历史到文件
   */
  async saveSessionHistory(): Promise<void> {
    try {
      const messageHistory = this.getMessageHistory();
      const todos = this.getTodos();
      const todoTasks = this.listTodoTasks(MAIN_AGENT_ID);
      const readFileTimestamps = this.getReadFileTimestamps(MAIN_AGENT_ID);
      const workingDir = getConfManager().getCoreConfig()?.workingDir;
      if (this.sessionId && messageHistory.length > 0) {
        await saveHistory(this.sessionId, messageHistory, todos, workingDir, readFileTimestamps, todoTasks);
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
    if (this.globalEditPermissionGranted) return;
    this.globalEditPermissionGranted = true;
    logInfo('全局编辑权限已授予');
    this.emitAutoEditUpdate(true);
  }

  /**
   * 设置自动编辑状态（仅在 skipFileEditPermission 为 false 时生效）
   */
  updateAutoEdit(enable: boolean): void {
    const coreConfig = getConfManager().getCoreConfig();
    if (coreConfig?.skipFileEditPermission) return;
    if (this.globalEditPermissionGranted === enable) return;
    this.globalEditPermissionGranted = enable;
    logInfo(`自动编辑已${enable ? '开启' : '关闭'}`);
    this.emitAutoEditUpdate(enable);
  }

  /**
   * 发送自动编辑状态更新事件
   */
  private emitAutoEditUpdate(enable: boolean): void {
    const data: AutoEditUpdateData = { enable };
    getEventBus().emit('autoEdit:update', data);
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
   * 检查 Design 模式信息是否已发送
   */
  isDesignModeInfoSent(): boolean {
    return this.designModeInfoSent;
  }

  /**
   * 标记 Design 模式信息已发送
   */
  markDesignModeInfoSent(): void {
    this.designModeInfoSent = true;
    logInfo('Design 模式信息已标记为已发送');
  }

  /**
   * 重置 Design 模式信息发送状态
   */
  resetDesignModeInfoSent(): void {
    this.designModeInfoSent = false;
    logInfo('Design 模式信息发送状态已重置');
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
      setTodos: (todos: TodoItem[]) => this.setTodos(todos, agentId),
      updateTodosIntelligently: (todos: TodoItem[]) => this.updateTodosIntelligently(todos, agentId),
      clearTodos: () => {
        if (isSubagent) {
          this.clearAgentTodos(agentId);
        }
      },

      // 消息历史管理
      getMessageHistory: () => this.getMessageHistory(agentId),
      setMessageHistory: (messages: Message[], skipAutoSave?: boolean) => this.setMessageHistory(messages, agentId, skipAutoSave),
      finalizeMessages: (messages: Message[]) => {
        this.setMessageHistory(messages, agentId);
        this.updateState('idle', agentId);
      },
      flushHistory: () => this.saveSessionHistory(),

      // 文件读取时间戳管理
      getReadFileTimestamps: () => this.getReadFileTimestamps(agentId),
      getReadFileTimestamp: (filePath: string) => this.getReadFileTimestamp(filePath, agentId),
      setReadFileTimestamp: (filePath: string, timestamp: number) => this.setReadFileTimestamp(filePath, timestamp, agentId),
      setReadFileTimestamps: (timestamps: Record<string, number>) => this.setReadFileTimestamps(timestamps, agentId),

      // 文件换行符缓存
      getFileLineEnding: (filePath: string) => this.getFileLineEnding(filePath, agentId),
      setFileLineEnding: (filePath: string, ending: LineEndingKind) => this.setFileLineEnding(filePath, ending, agentId),

      // 状态管理
      getCurrentState: () => this.getCurrentState(agentId),
      updateState: (state: AppSessionState) => this.updateState(state, agentId),

      // TodoTask CRUD
      createTodoTask: (task) => this.createTodoTask(agentId, task),
      getTodoTask: (taskId) => this.getTodoTask(agentId, taskId),
      listTodoTasks: () => this.listTodoTasks(agentId),
      updateTodoTask: (taskId, updates) => this.updateTodoTask(agentId, taskId, updates),
      deleteTodoTask: (taskId) => this.deleteTodoTask(agentId, taskId),
      blockTask: (fromId, toId) => this.blockTask(agentId, fromId, toId),

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
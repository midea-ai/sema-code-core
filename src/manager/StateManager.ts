
/**
 * 多会话状态管理
 *
 * 两层隔离：sessionId → agentId
 * - StateManager 是单例注册表，持有 Map<sessionId, SessionRuntime>
 * - SessionRuntime 持有单个会话的全部状态：
 *   - 按 agentId 隔离：statesMap / messageHistoryMap / readFileTimestampsMap / todosMap / todoTasksMap
 *     （agentId='main' 为该会话主代理，子代理为各自 taskId）
 *   - 会话级：abortController / 输入队列 / 编辑权限 / Plan&Design 模式标记 / 前台 agent 集合
 *   - 会话级配置：agentMode / useTools
 *
 * 子代理不触发 conversation:usage、message:chunk、tool:execution:chunk、state:update、todos:update、topic:update
 * 子代理相关事件 message:complete、tool:execution:complete、tool:execution:error、session:interrupted、tool:permission:request、tool:permission:auto 有agentId字段
 */

import * as crypto from 'crypto';
import { getEventBus } from '../events/EventSystem';
import { StateUpdateData, AppSessionState, TodoItem, PermissionLevelUpdateData } from '../events/types';
import { logInfo } from '../util/log';
import { saveHistory } from '../util/history';
import { Message, InputImageAttachment } from '../types/message';
import { getConfManager } from './ConfManager';
import { TodoTask, TodoTaskStatus } from '../types/todoTask';
import { LineEndingKind } from '../util/file';
import type { AgentContext } from '../types/agent';
import type { AgentMode, PermissionLevel } from '../types';


// 待处理用户输入项
export interface PendingUserInput {
  inputId: string;
  input: string;
  originalInput?: string;
  silent?: boolean;
  type: 'inject' | 'command'; // inject=普通文本，command=以/开头的命令
  attachments?: InputImageAttachment[]; // 用户粘贴的图片附件
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
 * 封装对特定 (sessionId, agentId) 的所有状态访问
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

  // 工具搜索：本代理已动态加载的工具名（主代理即会话级名单）
  getLoadedToolNames(): string[];
  addLoadedTools(names: string[]): string[];

  // 清理
  clearAllState(): void;
}

/**
 * 单个会话的运行时状态
 * 由 StateManager 按 sessionId 持有
 */
export class SessionRuntime {
  // === 按 agentId 隔离 ===
  private statesMap: Map<string, AgentState> = new Map();
  private messageHistoryMap: Map<string, Message[]> = new Map();
  private readFileTimestampsMap: Map<string, Record<string, number>> = new Map();
  private todosMap: Map<string, TodoItem[]> = new Map();
  private todoTasksMap: Map<string, TodoTask[]> = new Map();
  private fileLineEndingsMap: Map<string, Record<string, LineEndingKind>> = new Map();

  // === 会话级状态 ===
  public currentAbortController: AbortController | null = null;
  private permissionLevel: PermissionLevel = 'Ask';
  private planModeInfoSent = false;
  private designModeInfoSent = false;

  // 项目外读取已授权的父目录集合（会话级，不持久化）
  private allowedExternalReadDirs = new Set<string>();

  // 历史文件命名格式：true 表示本会话使用无日期文件名（会话id.json），用于固定会话持久化
  private historyNoDate = false;

  // 当前正在运行的前台 agent taskId 集合
  private foregroundAgents = new Set<string>();

  // 待处理用户输入队列
  private pendingUserInputs: PendingUserInput[] = [];

  // === 会话级配置（从全局 coreConfig 下沉到会话级）===
  public agentMode: AgentMode = 'Agent';

  // 工具搜索模式下本会话已动态加载的工具名（内置名或 mcp__ 全名）
  // append-only：顺序即 tools 数组尾部的追加顺序，保证 LLM 前缀缓存稳定，不提供移除/重排
  private loadedToolNames: string[] = [];

  // 工具搜索模式下各子代理已动态加载的工具名（agentId → append-only 名单）
  // 主代理沿用会话级 loadedToolNames，不入此 Map；子代理结束随 clearAgentState 清理
  private agentLoadedToolNamesMap: Map<string, string[]> = new Map();

  // 会话级系统提示快照：首次构建后冻结，整个会话不再变化
  private systemPromptContent: Array<{ type: 'text'; text: string }> | null = null;

  constructor(public readonly sessionId: string) {}

  // ============================================================
  // 消息历史管理（按代理隔离）
  // ============================================================

  setMessageHistory(messages: Message[], agentId: string = MAIN_AGENT_ID, skipAutoSave = false): void {
    this.messageHistoryMap.set(agentId, messages);
    // 主代理设置消息历史时自动保存
    if (!skipAutoSave && agentId === MAIN_AGENT_ID && messages.length > 0) {
      this.saveSessionHistory();
    }
  }

  getMessageHistory(agentId: string = MAIN_AGENT_ID): Message[] {
    return this.messageHistoryMap.get(agentId) || [];
  }

  // ============================================================
  // 文件读取时间戳管理（按代理隔离）
  // ============================================================

  getReadFileTimestamps(agentId: string = MAIN_AGENT_ID): Record<string, number> {
    let timestamps = this.readFileTimestampsMap.get(agentId);
    if (!timestamps) {
      timestamps = {};
      this.readFileTimestampsMap.set(agentId, timestamps);
    }
    return timestamps;
  }

  setReadFileTimestamp(filePath: string, timestamp: number, agentId: string = MAIN_AGENT_ID): void {
    const timestamps = this.getReadFileTimestamps(agentId);
    timestamps[filePath] = timestamp;
  }

  setReadFileTimestamps(timestamps: Record<string, number>, agentId: string = MAIN_AGENT_ID): void {
    this.readFileTimestampsMap.set(agentId, { ...timestamps });
  }

  getReadFileTimestamp(filePath: string, agentId: string = MAIN_AGENT_ID): number | undefined {
    return this.getReadFileTimestamps(agentId)[filePath];
  }

  // ============================================================
  // 文件换行符缓存（按代理隔离）
  // ============================================================

  getFileLineEnding(filePath: string, agentId: string = MAIN_AGENT_ID): LineEndingKind | undefined {
    return this.fileLineEndingsMap.get(agentId)?.[filePath];
  }

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

  getTodos(agentId: string = MAIN_AGENT_ID): TodoItem[] {
    return this.todosMap.get(agentId) || [];
  }

  setTodos(todos: TodoItem[], agentId: string = MAIN_AGENT_ID): void {
    this.todosMap.set(agentId, todos);
  }

  clearAgentTodos(agentId: string): void {
    if (agentId !== MAIN_AGENT_ID) {
      this.todosMap.delete(agentId);
      logInfo(`[${agentId}] todos已清理`);
    }
  }

  updateTodosIntelligently(newTodos: TodoItem[], agentId: string = MAIN_AGENT_ID): void {
    const currentTodos = this.todosMap.get(agentId) || [];

    if (newTodos.length === 0) {
      // 本来就是空的则静默返回：压缩/清空路径固定传 []，避免"空→空"也发 todos:update
      if (currentTodos.length === 0) {
        return;
      }
      this.todosMap.set(agentId, newTodos);
      logInfo(`[${agentId}] todos完全替换: ${newTodos.length} 项`);
      if (agentId === MAIN_AGENT_ID) {
        this.emitTodosUpdateEvent(newTodos);
      }
      return;
    }

    const isSubsetUpdate = newTodos.every(todo =>
      todo.id && currentTodos.some(existing => existing.id === todo.id)
    );

    if (isSubsetUpdate && currentTodos.length > 0) {
      const updatedTodos = currentTodos.map(existing => {
        const update = newTodos.find(todo => todo.id === existing.id);
        return update || existing;
      });
      this.todosMap.set(agentId, updatedTodos);
      logInfo(`[${agentId}] todos子集更新: ${newTodos.length} 项更新，总共 ${updatedTodos.length} 项`);
      if (agentId === MAIN_AGENT_ID) {
        this.emitTodosUpdateEvent(newTodos);
      }
    } else {
      this.todosMap.set(agentId, newTodos);
      logInfo(`[${agentId}] todos完全替换: ${newTodos.length} 项`);
      if (agentId === MAIN_AGENT_ID) {
        this.emitTodosUpdateEvent(newTodos);
      }
    }
  }

  private emitTodosUpdateEvent(todos: TodoItem[]): void {
    getEventBus().emit('todos:update', todos, this.sessionId);
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
    for (const t of tasks) {
      t.blocks = t.blocks.filter(id => id !== taskId);
      t.blockedBy = t.blockedBy.filter(id => id !== taskId);
    }
    logInfo(`[${agentId}] TodoTask deleted: ${taskId}`);
    this.syncTodoTasksToTodos(agentId);
    return true;
  }

  blockTask(agentId: string, fromId: string, toId: string): boolean {
    const tasks = this.getTodoTasks(agentId);
    const fromTask = tasks.find(t => t.id === fromId);
    const toTask = tasks.find(t => t.id === toId);
    if (!fromTask || !toTask) return false;

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

  restoreTodoTasks(tasks: TodoTask[]): void {
    const normalized = tasks.map(t => ({
      ...t,
      blocks: t.blocks ?? [],
      blockedBy: t.blockedBy ?? [],
    }));
    this.todoTasksMap.set(MAIN_AGENT_ID, normalized);
    logInfo(`TodoTasks restored: ${tasks.length} 项`);
  }

  restoreTodoTasksFromLegacy(todos: TodoItem[]): void {
    const now = Date.now();
    const tasks: TodoTask[] = todos.map((todo) => ({
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

  private syncTodoTasksToTodos(agentId: string): void {
    const tasks = this.getTodoTasks(agentId);

    const statusOrder: Record<string, number> = { completed: 0, in_progress: 1, pending: 2 };
    const completedIds = new Set(tasks.filter(t => t.status === 'completed').map(t => t.id));

    const sorted = [...tasks].sort((a, b) => {
      const oa = statusOrder[a.status] ?? 3;
      const ob = statusOrder[b.status] ?? 3;
      if (oa !== ob) return oa - ob;
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

    logInfo(`updateState: sessionId=${this.sessionId}, agentId=${agentId}, current=${agentState.currentState}, new=${newState}`);

    if (agentState.currentState !== newState) {
      agentState.previousState = agentState.currentState;
      agentState.currentState = newState;

      if (agentId === MAIN_AGENT_ID) {
        const stateData: StateUpdateData = { state: newState };
        getEventBus().emit('state:update', stateData, this.sessionId);
        logInfo(`状态更新: ${agentState.previousState} → ${newState}`);
      } else {
        logInfo(`[${agentId}] 状态更新: ${agentState.previousState} → ${newState}`);
      }
    } else {
      logInfo(`updateState: 状态未变化`);
    }
  }

  getCurrentState(agentId: string = MAIN_AGENT_ID): AppSessionState {
    return this.getAgentState(agentId).currentState;
  }

  // ============================================================
  // 前台 Agent 管理（会话级）
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
  // 待处理用户输入队列管理（会话级）
  // ============================================================

  addPendingUserInput(item: PendingUserInput): void {
    this.pendingUserInputs.push(item);
  }

  getPendingUserInputsLength(): number {
    return this.pendingUserInputs.length;
  }

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

  consumeAllPendingInputs(): PendingUserInput[] {
    return this.pendingUserInputs.splice(0);
  }

  clearPendingUserInputs(): void {
    this.pendingUserInputs = [];
  }

  // ============================================================
  // 工具搜索：已动态加载的工具（append-only）
  // ============================================================

  getLoadedToolNames(): string[] {
    return [...this.loadedToolNames];
  }

  /**
   * 去重后追加工具名，返回实际新增的工具名
   */
  addLoadedTools(names: string[]): string[] {
    const added: string[] = [];
    for (const name of names) {
      if (!this.loadedToolNames.includes(name) && !added.includes(name)) {
        added.push(name);
      }
    }
    this.loadedToolNames.push(...added);
    return added;
  }

  /** 指定代理已动态加载的工具名（主代理即会话级名单） */
  getAgentLoadedToolNames(agentId: string): string[] {
    if (agentId === MAIN_AGENT_ID) {
      return this.getLoadedToolNames();
    }
    return [...(this.agentLoadedToolNamesMap.get(agentId) || [])];
  }

  /**
   * 为指定代理去重后追加工具名，返回实际新增的工具名（主代理委托会话级 addLoadedTools）
   */
  addAgentLoadedTools(names: string[], agentId: string): string[] {
    if (agentId === MAIN_AGENT_ID) {
      return this.addLoadedTools(names);
    }
    const list = this.agentLoadedToolNamesMap.get(agentId) || [];
    const added: string[] = [];
    for (const name of names) {
      if (!list.includes(name) && !added.includes(name)) {
        added.push(name);
      }
    }
    list.push(...added);
    this.agentLoadedToolNamesMap.set(agentId, list);
    return added;
  }

  // ============================================================
  // 清理
  // ============================================================

  /**
   * 清空本会话所有状态数据
   */
  clearAllState(): void {
    this.statesMap.clear();
    this.messageHistoryMap.clear();
    this.readFileTimestampsMap.clear();
    this.todosMap.clear();
    this.todoTasksMap.clear();
    this.fileLineEndingsMap.clear();

    this.currentAbortController = null;
    this.systemPromptContent = null;
    this.permissionLevel = 'Ask';
    this.planModeInfoSent = false;
    this.designModeInfoSent = false;
    this.foregroundAgents.clear();
    this.clearPendingUserInputs();
    this.loadedToolNames = [];
    this.agentLoadedToolNamesMap.clear();

    logInfo(`[${this.sessionId}] 所有状态数据已清空`);
  }

  /**
   * 清理指定子代理的所有隔离状态
   */
  clearAgentState(agentId: string): void {
    if (agentId !== MAIN_AGENT_ID) {
      this.statesMap.delete(agentId);
      this.messageHistoryMap.delete(agentId);
      this.readFileTimestampsMap.delete(agentId);
      this.todosMap.delete(agentId);
      this.todoTasksMap.delete(agentId);
      this.fileLineEndingsMap.delete(agentId);
      this.agentLoadedToolNamesMap.delete(agentId);
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
      if (messageHistory.length > 0) {
        await saveHistory(this.sessionId, messageHistory, todos, workingDir, readFileTimestamps, todoTasks, this.historyNoDate);
        logInfo(`会话历史已保存: ${this.sessionId}`);
      }
    } catch (error) {
      logInfo(`保存会话历史失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 设置本会话历史文件是否使用无日期命名（会话id.json） */
  setHistoryNoDate(noDate: boolean): void {
    this.historyNoDate = noDate;
  }

  /** 本会话历史文件是否使用无日期命名 */
  getHistoryNoDate(): boolean {
    return this.historyNoDate;
  }

  // ============================================================
  // 权限自由度档位（会话级）
  // ============================================================

  getPermissionLevel(): PermissionLevel {
    return this.permissionLevel;
  }

  /** 当前是否为 AutoRun 档位（最高自由度，需做自动判断） */
  isAutoRun(): boolean {
    return this.permissionLevel === 'AutoRun';
  }

  /** 当前是否为 Bypass 档位（跳过一切安全检查，危险） */
  isBypass(): boolean {
    return this.permissionLevel === 'Bypass';
  }

  /**
   * 非 Ask 档（AutoEdit / AutoRun）时项目内文件编辑自动放行。
   * 命名保留以最小化权限检查处的改动，语义不变。
   */
  hasGlobalEditPermission(): boolean {
    return this.permissionLevel !== 'Ask';
  }

  /**
   * 用户在文件编辑弹窗选择"本次会话不再询问文件编辑"时调用：
   * 仅当当前为 Ask 时提升到 AutoEdit；已是 AutoEdit/AutoRun 则不降级。
   */
  grantGlobalEditPermission(): void {
    if (this.permissionLevel !== 'Ask') return;
    this.permissionLevel = 'AutoEdit';
    logInfo(`[${this.sessionId}] 权限档位提升至 AutoEdit`);
    this.emitPermissionLevelUpdate('AutoEdit');
  }

  /**
   * 用户在项目外文件读取弹窗选择"本次会话不再询问该目录读取"时调用：
   * 将文件父目录加入会话级授权集合，不持久化到项目配置。
   */
  grantExternalReadDir(dirPath: string): void {
    this.allowedExternalReadDirs.add(dirPath);
    logInfo(`[${this.sessionId}] 项目外读取已授权目录: ${dirPath}`);
  }

  /** 返回本会话已授权的项目外读取父目录列表 */
  getAllowedExternalReadDirs(): string[] {
    return [...this.allowedExternalReadDirs];
  }

  /**
   * 设置权限自由度档位。
   */
  setPermissionLevel(level: PermissionLevel): void {
    if (this.permissionLevel === level) return;
    this.permissionLevel = level;
    logInfo(`[${this.sessionId}] 权限档位已设为 ${level}`);
    this.emitPermissionLevelUpdate(level);
  }

  private emitPermissionLevelUpdate(level: PermissionLevel): void {
    const data: PermissionLevelUpdateData = { level };
    getEventBus().emit('permissionLevel:update', data, this.sessionId);
  }

  // ============================================================
  // Plan / Design 模式信息发送标记（会话级）
  // ============================================================

  isPlanModeInfoSent(): boolean {
    return this.planModeInfoSent;
  }

  markPlanModeInfoSent(): void {
    this.planModeInfoSent = true;
    logInfo(`[${this.sessionId}] Plan 模式信息已标记为已发送`);
  }

  resetPlanModeInfoSent(): void {
    this.planModeInfoSent = false;
    logInfo(`[${this.sessionId}] Plan 模式信息发送状态已重置`);
  }

  isDesignModeInfoSent(): boolean {
    return this.designModeInfoSent;
  }

  markDesignModeInfoSent(): void {
    this.designModeInfoSent = true;
    logInfo(`[${this.sessionId}] Design 模式信息已标记为已发送`);
  }

  resetDesignModeInfoSent(): void {
    this.designModeInfoSent = false;
    logInfo(`[${this.sessionId}] Design 模式信息发送状态已重置`);
  }

  // ============================================================
  // 系统提示快照（会话级，整会话不变）
  // ============================================================

  getSystemPromptContent(): Array<{ type: 'text'; text: string }> | null {
    return this.systemPromptContent;
  }

  setSystemPromptContent(content: Array<{ type: 'text'; text: string }>): void {
    this.systemPromptContent = content;
  }

  /**
   * 为指定 agentId 创建状态访问代理对象
   */
  forAgent(agentId: string): AgentStateAccessor {
    const isSubagent = agentId !== MAIN_AGENT_ID;

    return {
      getTodos: () => this.getTodos(agentId),
      setTodos: (todos: TodoItem[]) => this.setTodos(todos, agentId),
      updateTodosIntelligently: (todos: TodoItem[]) => this.updateTodosIntelligently(todos, agentId),
      clearTodos: () => {
        if (isSubagent) {
          this.clearAgentTodos(agentId);
        }
      },

      getMessageHistory: () => this.getMessageHistory(agentId),
      setMessageHistory: (messages: Message[], skipAutoSave?: boolean) => this.setMessageHistory(messages, agentId, skipAutoSave),
      finalizeMessages: (messages: Message[]) => {
        this.setMessageHistory(messages, agentId);
        this.updateState('idle', agentId);
      },
      flushHistory: () => this.saveSessionHistory(),

      getReadFileTimestamps: () => this.getReadFileTimestamps(agentId),
      getReadFileTimestamp: (filePath: string) => this.getReadFileTimestamp(filePath, agentId),
      setReadFileTimestamp: (filePath: string, timestamp: number) => this.setReadFileTimestamp(filePath, timestamp, agentId),
      setReadFileTimestamps: (timestamps: Record<string, number>) => this.setReadFileTimestamps(timestamps, agentId),

      getFileLineEnding: (filePath: string) => this.getFileLineEnding(filePath, agentId),
      setFileLineEnding: (filePath: string, ending: LineEndingKind) => this.setFileLineEnding(filePath, ending, agentId),

      getCurrentState: () => this.getCurrentState(agentId),
      updateState: (state: AppSessionState) => this.updateState(state, agentId),

      createTodoTask: (task) => this.createTodoTask(agentId, task),
      getTodoTask: (taskId) => this.getTodoTask(agentId, taskId),
      listTodoTasks: () => this.listTodoTasks(agentId),
      updateTodoTask: (taskId, updates) => this.updateTodoTask(agentId, taskId, updates),
      deleteTodoTask: (taskId) => this.deleteTodoTask(agentId, taskId),
      blockTask: (fromId, toId) => this.blockTask(agentId, fromId, toId),

      getLoadedToolNames: () => this.getAgentLoadedToolNames(agentId),
      addLoadedTools: (names: string[]) => this.addAgentLoadedTools(names, agentId),

      clearAllState: () => {
        if (isSubagent) {
          this.clearAgentState(agentId);
        }
      },
    };
  }
}

/**
 * 全局状态管理器（单例注册表）
 * 按 sessionId 持有多个 SessionRuntime
 */
export class StateManager {
  private static instance: StateManager | null = null;

  private sessions: Map<string, SessionRuntime> = new Map();

  /** UI 层当前打开的活跃会话（多会话共存时由 UI 指定，用于通知兜底投递） */
  private activeSessionId: string | null = null;

  private constructor() {}

  static getInstance(): StateManager {
    if (!StateManager.instance) {
      StateManager.instance = new StateManager();
    }
    return StateManager.instance;
  }

  /**
   * 获取（不存在则创建）指定会话的运行时
   */
  session(sessionId: string): SessionRuntime {
    let runtime = this.sessions.get(sessionId);
    if (!runtime) {
      runtime = new SessionRuntime(sessionId);
      this.sessions.set(sessionId, runtime);
      logInfo(`SessionRuntime 已创建: ${sessionId}`);
    }
    return runtime;
  }

  /**
   * 从 AgentContext 直接取得代理状态访问器
   */
  forAgent(ctx: AgentContext): AgentStateAccessor {
    return this.session(ctx.sessionId).forAgent(ctx.agentId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** 设置 UI 层当前活跃会话 */
  setActiveSession(sessionId: string): void {
    this.activeSessionId = sessionId;
  }

  /** 获取 UI 层当前活跃会话（未设置或已关闭则为 null） */
  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  /**
   * 移除单个会话的全部状态（会话级 dispose）
   */
  removeSession(sessionId: string): void {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      runtime.clearAllState();
      this.sessions.delete(sessionId);
      logInfo(`SessionRuntime 已移除: ${sessionId}`);
    }
    // 活跃会话被关闭：清空，等待 UI 指定新的活跃会话
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null;
    }
  }

  /**
   * 清空所有会话（进程级 dispose）
   */
  clearAll(): void {
    for (const runtime of this.sessions.values()) {
      runtime.clearAllState();
    }
    this.sessions.clear();
    this.activeSessionId = null;
    logInfo(`所有会话状态数据已清空`);
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }
}

/**
 * 获取 StateManager 单例实例
 */
export const getStateManager = () => StateManager.getInstance();

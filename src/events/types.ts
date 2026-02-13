// Sema-Core 事件系统类型定义

// ==================== 事件总线核心类型 ====================

/**
 * 事件监听器函数类型
 * @template T 事件数据类型
 */
export interface EventListener<T = any> {
  (data: T): void;
}

/**
 * 事件总线接口定义
 * 提供事件的发布/订阅功能，实现核心与UI/业务逻辑的解耦
 */
export interface EventBusInterface {
  /** 触发指定事件 */
  emit<T>(event: string, data: T): boolean;
  /** 监听指定事件 */
  on<T>(event: string, listener: EventListener<T>): this;
  /** 取消监听指定事件 */
  off<T>(event: string, listener: EventListener<T>): this;
  /** 一次性监听指定事件 */
  once<T>(event: string, listener: EventListener<T>): this;
  /** 移除指定事件的所有监听器，如不指定事件则移除所有 */
  removeAllListeners(event?: string): this;
  /** 检查指定事件是否有监听器 */
  hasListeners(event: string): boolean;
  /** 获取指定事件的监听器数量 */
  listenerCount(event: string): number;
  /** 获取所有已注册的事件名称 */
  eventNames(): string[];
}

// ==================== 会话生命周期事件 ====================

/**
 * 会话准备就绪事件数据
 * 事件: `session:ready`
 */
export interface SessionReadyData {
  workingDir: string;           // 工作目录路径
  sessionId: string;            // 会话唯一标识
  historyLoaded: boolean;       // 是否加载了历史记录
  usage: Usage;                 // token使用情况
  projectInputHistory: string[]; // 项目历史输入记录
}

/**
 * 会话被中断事件数据
 * 事件: `session:interrupted`
 */
export interface SessionInterruptedData {
  agentId: string;              // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  content: string;              // 中断原因描述，如 "Process cancelled by user"
}

/**
 * 会话错误事件数据
 * 事件: `session:error`
 */
export interface SessionErrorData {
  /** 错误类型 */
  type: 'api_error' | 'fatal_error' | 'context_length_exceeded' | 'model_error';
  /** 错误详情 */
  error: {
    /** 错误代码 */
    code: string;
    /** 错误描述信息 */
    message: string;
    /** 错误详细信息（可选） */
    details?: any;
  };
}

/**
 * 会话被清空事件数据
 * 事件: `session:cleared`
 */
export interface SessionClearedData {
  sessionId: string | null;     // 被清空的会话ID，为null表示当前会话
}

// ==================== 状态管理事件 ====================

/**
 * 会话状态类型定义
 * 用于表示Core内部的处理状态
 */
export type SessionState =
  | 'idle'                // 空闲状态，等待用户输入 → 显示"发送"按钮
  | 'processing'          // AI处理中 → 显示"中断"按钮

/**
 * 状态更新事件数据
 * 事件: `state:update`
 */
export interface StateUpdateData {
  state: SessionState;    // 当前状态
}

// ==================== AI消息事件 ====================

/**
 * 思考内容流式输出片段事件数据
 * 事件: `message:thinking:chunk`
 */
export interface ThinkingChunkData {
  content: string;
  delta: string;
}

/**
 * 文本内容流式输出片段事件数据
 * 事件: `message:text:chunk`
 */
export interface TextChunkData {
  content: string;
  delta: string;
}

/**
 * 消息完成事件数据
 * 事件: `message:complete`
 */
export interface MessageCompleteData {
  agentId: string;        // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  reasoning: string;      // 推理过程内容（如果有）
  content: string;        // 完整的回复内容
  hasToolCalls: boolean;  // 是否包含工具调用
  /** 工具调用列表（hasToolCalls为true时存在） */
  toolCalls?: Array<{
    name: string;                  // 工具名称
    args: Record<string, any>;     // 工具参数
  }>;
}

// ==================== 工具相关事件 ====================

/**
 * 工具权限请求事件数据
 * 事件: `tool:permission:request`
 */
export interface ToolPermissionRequestData {
  agentId: string;       // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  toolName: string;                  // 工具名称
  title: string;                     // 工具执行标题
  content: string | Record<string, any>;  // 权限说明文字（字符串或JSON对象）
  options: Record<string, string>;   // 可选操作字典
}

/**
 * 工具执行完成事件数据
 * 事件: `tool:execution:complete`
 */
export interface ToolExecutionCompleteData {
  agentId: string;       // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  toolName: string;      // 工具名称
  title: string;         // 工具执行标题
  summary: string;       // 工具执行摘要
  content: string | Record<string, any>;  // 工具执行结果内容（字符串或JSON对象）
}

/**
 * 工具执行错误事件数据
 * 事件: `tool:execution:error`
 */
export interface ToolExecutionErrorData {
  agentId: string;       // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  toolName: string;      // 工具名称
  title: string;         // 工具标题
  content: string;       // 工具错误内容
}

/**
 * 工具权限响应数据类型
 * 用于向Core返回用户的权限选择
 */
export interface ToolPermissionResponse {
  toolName: string;      // 工具名称
  selected: string;      // 用户选择的操作标识，如 'agree' | 'allow' | 'refuse' 或其他自定义选项
}

// ==================== 待办事项相关类型 ====================

/**
 * 待办事项项类型定义
 */
export interface TodoItem {
  content: string;     // 任务描述或内容，祈使句形式（例如："运行测试"）
  status: 'pending' | 'in_progress' | 'completed';  // 任务状态
  activeForm: string;  // 执行期间显示的现在进行时形式（例如："正在运行测试"）
}

/**
 * 待办事项更新事件数据
 * 事件: `todos:update`
 * 说明: TodoWriteTool工具执行后触发，todos状态发生变化
 */
export type TodosUpdateData = TodoItem[];

// ==================== 主题相关事件 ====================

/**
 * 主题更新事件数据
 * 事件: `topic:update`
 */
export interface TopicUpdateData {
  isNewTopic: boolean;  // 是否为新话题，false表示null（无新话题）
  title: string;        // 标题内容
}

// ==================== 使用统计相关类型 ====================

/**
 * Token使用情况类型定义
 */
export interface Usage {
  useTokens: number;    // 当前会话已使用的token数
  maxTokens: number;    // 模型最大token限制
  promptTokens: number; // 提示词使用的token数
}

/**
 * 对话使用统计事件数据
 * 事件: `conversation:usage`
 * 说明: 每次AI响应完成后触发，用于统计token使用情况
 */
export interface ConversationUsageData {
  usage: Usage;         // token使用情况
}

/**
 * 压缩执行统计数据
 * 事件: `compact:exec`
 * 用于记录上下文压缩的相关统计信息
 */
export interface CompactExecData {
  errMsg?: string
  tokenBefore: number;   // 压缩前输入token数
  tokenCompact: number;  // 压缩后输入token数
  compactRate: number;   // 压缩率，如0.235表示压缩到23.5%
}

/**
 * 文件引用事件数据
 * 事件: `file:reference`
 */
export interface FileReferenceData {
  references: Array<{
    type: 'file' | 'dir';
    name: string;
    content: string;
  }>;
}

// ==================== 问答交互事件 ====================

/**
 * 问答选项类型定义
 */
export interface AskQuestionOption {
  label: string;            // 选项显示文本
  description: string;      // 选项说明
}

/**
 * 问答问题类型定义
 */
export interface AskQuestion {
  question: string;         // 问题内容
  header: string;           // 问题标签（最多12字符）
  options: AskQuestionOption[];  // 选项列表（2-4个）
  multiSelect: boolean;     // 是否允许多选
}

/**
 * 问答请求事件数据
 * 事件: `ask:question:request`
 */
export interface AskQuestionRequestData {
  agentId: string;          // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  questions: AskQuestion[]; // 问题列表（1-4个）
  metadata?: {
    source?: string;        // 问题来源标识
  };
}

/**
 * 问答响应事件数据
 * 事件: `ask:question:response`
 */
export interface AskQuestionResponseData {
  agentId: string;          // 代理ID
  answers: Record<string, string>;  // 问题 -> 答案（多选时用逗号分隔）
}

// ==================== Plan模式相关事件 ====================

/**
 * 退出Plan模式权限请求事件数据
 * 事件: `plan:exit:request`
 */
export interface PlanExitRequestData {
  agentId: string;          // 代理ID
  planFilePath: string;     // 计划文件相对路径
  planContent: string;      // 计划文件内容
  options: {
    startEditing: string;           // "开始代码编辑"
    clearContextAndStart: string;   // "清理上下文，并开始代码编辑"
  };
}

/**
 * 退出Plan模式权限响应事件数据
 * 事件: `plan:exit:response`
 */
export interface PlanExitResponseData {
  agentId: string;          // 代理ID
  selected: 'startEditing' | 'clearContextAndStart';  // 用户选择的操作
}

/**
 * 计划实施事件数据
 * 事件: `plan:implement`
 * 说明: 仅当用户选择"清理上下文，并开始代码编辑"时触发
 */
export interface PlanImplementData {
  planFilePath: string;     // 计划文件相对路径
  planContent: string;      // 计划文件.md的内容
}

// ==================== 子代理相关事件 ====================

/**
 * 子代理开始事件数据
 * 事件: `task:agent:start`
 */
export interface TaskAgentStartData {
  taskId: string;           // 子代理任务唯一标识
  subagent_type: string;    // 子代理类型
  description: string;      // 任务描述
  prompt: string;           // 任务提示
}

/**
 * 子代理结束事件数据
 * 事件: `task:agent:end`
 */
export interface TaskAgentEndData {
  taskId: string;           // 子代理任务唯一标识
  status: 'completed' | 'failed' | 'interrupted';  // 执行状态
  content: string;          // 结果描述，如 'Interrupted' 或 'Done(12 tools use · 12.1k tokens · 2m 14s)'
}

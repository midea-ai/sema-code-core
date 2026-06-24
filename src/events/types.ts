import type { TodoItem } from '../types/todoTask';
import type { PermissionLevel } from '../types';
import type { InputImageAttachment } from '../types/message';

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
  /** 触发指定事件，sessionId 为路由元数据 */
  emit<T>(event: string, data: T, sessionId?: string | null): boolean;
  /** 监听指定事件，sessionId 限定只接收该会话的事件 */
  on<T>(event: string, listener: EventListener<T>, sessionId?: string | null): this;
  /** 取消监听指定事件 */
  off<T>(event: string, listener: EventListener<T>): this;
  /** 一次性监听指定事件 */
  once<T>(event: string, listener: EventListener<T>, sessionId?: string | null): this;
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
  pid: number;                  // Core进程ID
  workingDir: string;           // 工作目录路径
  sessionId: string;            // 会话唯一标识
  historyLoaded: boolean;       // 是否加载了历史记录
  usage: Usage;                 // token使用情况
  projectInputHistory: string[]; // 项目历史输入记录
  todos: TodoItem[];            // 待办事项列表
  readFileTimestamps: Record<string, number>;  // 文件读取时间戳
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
export type AppSessionState =
  | 'idle'                // 空闲状态，等待用户输入 → 显示"发送"按钮
  | 'processing'          // AI处理中 → 显示"中断"按钮

/**
 * 状态更新事件数据
 * 事件: `state:update`
 */
export interface StateUpdateData {
  state: AppSessionState;    // 当前状态
}

// ==================== 用户输入事件 ====================

/**
 * 用户输入已接收事件数据
 * 事件: `input:received`
 * 说明: processUserInput 收到用户输入时触发，无论是立即处理还是入队等待
 */
export interface InputReceivedData {
  inputId: string;            // 输入唯一标识，用于区分相同内容的不同输入
  input: string;              // 处理后的输入内容
  originalInput?: string;     // 原始输入内容
  queued: boolean;            // 是否入队等待（true 表示当前正在处理中，输入已入队）
  queueLength: number;        // 当前队列长度（入队后的长度）
}

/**
 * 用户输入开始处理事件数据
 * 事件: `input:processing`
 * 说明: processQuery 真正开始处理用户输入时触发
 */
export interface InputProcessingData {
  inputId: string;            // 输入唯一标识，与 input:received 中的 inputId 对应
  input: string;              // 正在处理的输入内容
  originalInput?: string;     // 原始输入内容
  attachments?: InputImageAttachment[]; // 该输入规范化后的图片附件（已过滤非法类型、已压缩），用于气泡回显
}

// ==================== AI消息事件 ====================

/**
 * 思考内容流式输出片段事件数据
 * 事件: `message:thinking:chunk`
 */
export interface ThinkingChunkData {
  id: string;      // 消息唯一ID，对应 Anthropic Message 的 id
  delta: string;
}

/**
 * 文本内容流式输出片段事件数据
 * 事件: `message:text:chunk`
 */
export interface TextChunkData {
  id: string;      // 消息唯一ID，对应 Anthropic Message 的 id
  delta: string;
}

/**
 * 消息完成事件数据
 * 事件: `message:complete`
 */
export interface MessageCompleteData {
  id: string;             // 消息唯一ID，对应 Anthropic Message 的 id
  agentId: string;        // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  reasoning: string;      // 推理过程内容（如果有）
  content: string;        // 完整的回复内容
  hasToolCalls: boolean;  // 是否包含工具调用
  /** 工具调用列表（hasToolCalls为true时存在） */
  toolCalls?: Array<{
    name: string;                  // 工具名称
  }>;
}

// ==================== 工具相关事件 ====================

/**
 * 工具权限请求事件数据
 * 事件: `tool:permission:request`
 */
export interface ToolPermissionRequestData {
  agentId: string;       // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  toolId: string;        // 工具调用唯一ID（对应 Anthropic ToolUseBlock 的 id），用于精确匹配响应
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
  toolId: string;        // 工具调用唯一ID（对应 Anthropic ToolUseBlock 的 id）
  toolName: string;      // 工具名称
  title: string;         // 工具执行标题
  summary: string;       // 工具执行摘要
  content: string | Record<string, any>;  // 工具执行结果内容（字符串或JSON对象）
}


/**
 * 工具执行中间态事件数据
 * 事件: `tool:execution:chunk`
 * 说明: 命令执行期间，工具结果的中间态（结构与 ToolExecutionCompleteData 相同， content只传delta）
 */
export type ToolExecutionChunkData = ToolExecutionCompleteData

/**
 * 工具执行错误事件数据
 * 事件: `tool:execution:error`
 */
export interface ToolExecutionErrorData {
  agentId: string;       // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  toolId?: string;       // 工具调用唯一ID（对应 Anthropic ToolUseBlock 的 id）
  toolName: string;      // 工具名称
  title: string;         // 工具标题
  content: string;       // 工具错误内容
  input?: Record<string, any>;  // 工具调用参数
}

/**
 * 工具权限响应数据类型
 * 用于向Core返回用户的权限选择
 */
export interface ToolPermissionResponse {
  toolId: string;        // 工具调用唯一ID，与请求中的 toolId 对应，用于精确匹配
  toolName: string;      // 工具名称
  selected: string;      // 用户选择的操作标识，如 'agree' | 'allow' | 'refuse' 或其他自定义选项
}

/**
 * 工具权限「模型自动放行」事件数据
 * 事件: `tool:permission:auto`
 * 说明: AutoRun 档位下，工具动作经快速模型判定为 safe 而自动放行时触发。
 *       仅「模型判断放行」才触发；只读白名单、项目内文件、Skill 等确定性放行不触发。
 *       UI 可据此提示"已由模型安全判断自动放行"。
 */
export interface ToolPermissionAutoData {
  agentId: string;       // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  toolId: string;        // 工具调用唯一ID（对应 Anthropic ToolUseBlock 的 id）
  toolName: string;      // 工具名称
  content: string;       // 一句简短的文字说明（UI 展示），如"已由模型安全判断自动放行"
}

// ==================== 待办事项相关类型 ====================

export type { TodoItem } from '../types/todoTask';

/**
 * 待办事项更新事件数据
 * 事件: `todos:update`
 * 说明: Task工具执行后触发，todos状态发生变化
 */
export type TodosUpdateData = TodoItem[];

// ==================== 权限档位事件 ====================

/**
 * 权限自由度档位更新事件数据
 * 事件: `permissionLevel:update`
 */
export interface PermissionLevelUpdateData {
  level: PermissionLevel;    // 当前权限档位：Ask | AutoEdit | AutoRun
}

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
  mode?: 'summary' | 'truncated' | 'failed'
  reason?: string
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
 * 问答题型联合类型
 *
 * - radio    : 单选（2–5 项）
 * - checkbox : 多选（2–7 项），可设 maxSelections 限制最多选择数
 * - select   : 下拉单选（6–10 项）
 * - text     : 单行文本输入
 * - textarea : 多行文本输入
 */
export type PickOptionQuestion =
  | {
      type: 'radio';
      id: string;
      label: string;
      required?: boolean;
      options: string[];
    }
  | {
      type: 'checkbox';
      id: string;
      label: string;
      required?: boolean;
      options: string[];
      maxSelections?: number;
    }
  | {
      type: 'select';
      id: string;
      label: string;
      required?: boolean;
      options: string[];
    }
  | {
      type: 'text';
      id: string;
      label: string;
      required?: boolean;
      placeholder?: string;
    }
  | {
      type: 'textarea';
      id: string;
      label: string;
      required?: boolean;
      placeholder?: string;
    };

/**
 * 问答请求事件数据
 * 事件: `pick:option:request`
 */
export interface PickOptionRequestData {
  agentId: string;                 // 代理ID（主代理为 MAIN_AGENT_ID，子代理为 taskId）
  questions: PickOptionQuestion[]; // 问题列表（1–7 个）
  estimatedTime?: string;          // 时间引导（UI 渲染，如 "30 秒"）
  intro?: string;                  // 流程引导（UI 渲染，一句话说明回答后会发生什么）
}

/**
 * 问答响应事件数据
 * 事件: `pick:option:response`
 *
 * answers 由前端预格式化为纯文本，例如：
 *   - 视觉气质: 极简高级 / Apple 风格
 *   - 大概多少页面？: (skipped)
 *
 * answers 为 null 表示用户取消整个表单（未提交）。
 */
export interface PickOptionResponseData {
  agentId: string;
  answers: string | null;
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
  agent_type: string;       // 代理类型
  title: string;            // 任务标题
  instructions: string;     // 任务指令
  background: boolean; // 是否后台运行
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


// ==================== 后台任务相关事件 ====================

/** 后台任务状态 */
export type CronTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

/**
 * 后台任务启动事件数据
 * 事件: `task:start`
 */
export interface TaskStartData {
  taskId: string;
  pid?: number;
  command: string;
  filepath: string;
  status: CronTaskStatus;
  type: 'RunShell' | 'SubAgent';
  agentType?: string;           // SubAgent任务专用：代理类型（对应 agent_type）
}

/**
 * 后台任务结束事件数据
 * 事件: `task:end`
 */
export interface TaskEndData {
  taskId: string;
  status: 'completed' | 'failed' | 'killed';
  summary: string;
}

/**
 * 前台任务转后台事件数据
 * 事件: `task:transfer`
 * 说明: 前台 Agent 通过 transferToBackground() 转为后台运行时触发
 * 数据格式与 TaskStartData 一致，便于UI层统一处理
 */
export type TaskTransferData = TaskStartData

// ==================== quickchat 旁路问答事件 ====================

/**
 * quickchat 旁路回答事件数据
 * 事件: `quickchat:response`
 * 说明: 用户通过 /quickchat 命令发起的旁路问题，不影响主对话状态
 */
export interface quickchatResponseData {
  question: string;   // 用户问题
  content: string;    // 回答内容
}

// ==================== 定时任务相关事件 ====================

/**
 * 定时任务更新事件
 * 事件: `cron:update`
 * 说明: 定时任务列表发生变化时触发，UI层收到后重新加载任务列表
 */
export interface CronUpdateData {}

// ==================== mcp状态相关事件 ====================

import type { MCPServerInfo } from '../types/mcp';

/**
 * mcp状态变更事件数据
 * 事件: `mcp:server:status`
 */
export type MCPServerStatusData = MCPServerInfo;

// ==================== 进程级事件白名单 ====================

/**
 * 进程级事件名
 * 这些事件描述全局资源状态变化，与具体会话无关，应通过 SemaCore.on 订阅。
 * 新增进程级事件时同步往这里补充。
 */
export type ProcessEvent = 'cron:update' | 'mcp:server:status';

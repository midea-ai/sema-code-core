/**
 * WebUI 共享类型：注册表 / 会话快照 / 消息块 / 协议帧。
 * 服务端与前端共用，仅依赖纯类型，不 import sema-core 运行时。
 */

export type AgentMode = 'Agent' | 'Plan' | 'Design';
/** WebUI 可选权限档位：不开放 Ask，最低 AutoEdit，默认 Bypass */
export type PermissionLevel = 'AutoEdit' | 'AutoRun' | 'Bypass';
export const PERMISSION_LEVELS: PermissionLevel[] = ['AutoEdit', 'AutoRun', 'Bypass'];
export const DEFAULT_PERMISSION_LEVEL: PermissionLevel = 'Bypass';
/** 归一化历史/外部值：Ask 及未知值 → AutoEdit */
export function normalizeLevel(l: any): PermissionLevel {
  return (PERMISSION_LEVELS as string[]).includes(l) ? l as PermissionLevel : 'AutoEdit';
}
export type SessionState = 'idle' | 'processing';

// ==================== 注册表 ====================

export interface ProjectRecord {
  id: string;
  name: string;
  workingDir: string;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  projectId?: string;
  workingDir: string;
  /** 目录由 WebUI 创建并管理；仅最后一个目录引用删除时才可清理 */
  managedWorkingDir?: boolean;
  /** 从哪个聊天分支而来（用于来源跳转） */
  branchedFromSessionId?: string;
  createdAt: number;
  lastActiveAt: number;
  agentMode: AgentMode;
  permissionLevel: PermissionLevel;
}

export interface Registry {
  schemaVersion: 1;
  projects: ProjectRecord[];
  sessions: SessionRecord[];
}

/** WebUI 全局设置（落盘 ~/.sema/webui/settings.json） */
export interface WebUISettings {
  coreConfig: {
    stream: boolean;
    thinking: boolean;
    customRules: string;
    skipFileEditPermission: boolean;
    skipShellExecPermission: boolean;
    skipSkillPermission: boolean;
    skipMCPToolPermission: boolean;
    skipFetchUrlPermission: boolean;
    skipExternalFileReadPermission: boolean;
    disableBackgroundTasks: boolean;
    enableToolSearch: boolean;
  };
  defaultAgentMode: AgentMode;
  defaultPermissionLevel: PermissionLevel;
  /** core worker 进程硬上限（配置 worker 不计入）；缺省 8，服务端 clamp 到 [2,16] */
  maxWorkers?: number;
}

// ==================== 输入框辅助 ====================

/** @ 文件引用搜索结果（相对 workingDir 的路径） */
export interface FileSearchItem { path: string; isDirectory: boolean }

/** / 面板条目：内置命令 / 自定义命令 / 技能 / 子代理 */
export interface SlashItem {
  name: string;
  description: string;
  category: 'command' | 'skill' | 'agent';
  /** 参数提示（自定义命令） */
  argumentHint?: string;
  /** 选中后直接发送（内置 clear/compact） */
  send?: boolean;
}

/** session.getCommandsInfo 返回：由该会话目录的 worker 给出，含项目级 .sema 配置 */
export interface CommandsInfo { commands: SlashItem[]; skills: SlashItem[]; agents: SlashItem[] }

// ==================== 消息块 ====================

export interface Usage {
  useTokens: number;
  maxTokens: number;
  promptTokens: number;
}

export interface TodoItem {
  id?: string;
  content?: string;
  status?: string;
  [k: string]: any;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffContent {
  type: 'diff' | 'new';
  patch: Hunk[];
  diffText?: string;
}

export interface FileChange {
  path: string;
  toolName: string;
  type: 'diff' | 'new';
  additions: number;
  removals: number;
  patch: Hunk[];
}

export interface ImageAttachmentMeta {
  media_type: string;
  /** 前端回显用的 dataURL（可能被裁剪，仅存缩略量级） */
  dataUrl?: string;
}

interface BlockBase {
  id: string;
  ts: number;
}

export interface UserBlock extends BlockBase {
  kind: 'user';
  inputId?: string;
  text: string;
  attachments?: ImageAttachmentMeta[];
  queued?: boolean;
  /** 输入来源，缺省 user；cron=定时任务自动发送（气泡加标签） */
  source?: 'user' | 'cron';
  /** 本轮结束时间（state 回到 idle 时打上），用于展示耗时分隔 */
  doneTs?: number;
}

export interface AssistantBlock extends BlockBase {
  kind: 'assistant';
  agentId: string;
  thinking: string;
  text: string;
  done: boolean;
}

export interface ToolBlock extends BlockBase {
  kind: 'tool';
  agentId: string;
  toolName: string;
  title: string;
  summary?: string;
  content?: any;
  /** run_shell 等流式输出累计 */
  output?: string;
  status: 'running' | 'done' | 'error';
  input?: Record<string, any>;
}

export interface PermissionBlock extends BlockBase {
  kind: 'permission';
  agentId: string;
  toolName: string;
  title: string;
  content: any;
  options: Record<string, string>;
  /** 已应答的选项 key；'__interrupted' 表示因中断作废 */
  resolved?: string;
}

export interface PickBlock extends BlockBase {
  kind: 'pick';
  agentId: string;
  questions: any[];
  intro?: string;
  estimatedTime?: string;
  resolved?: string | null;
  answered?: boolean;
}

export interface PlanExitBlock extends BlockBase {
  kind: 'plan-exit';
  agentId: string;
  planFilePath: string;
  planContent: string;
  options: Record<string, string>;
  resolved?: string;
}

export interface TodosBlock extends BlockBase {
  kind: 'todos';
  todos: TodoItem[];
}

export interface AgentBlock extends BlockBase {
  kind: 'agent';
  agentType: string;
  title: string;
  instructions: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  result?: string;
  blocks: Block[];
}

/** 分支会话中继承历史与新消息之间的来源边界 */
export interface BranchOriginBlock extends BlockBase {
  kind: 'branch-origin';
  sourceSessionId: string;
  sourceTitle: string;
}

export type NoticeType =
  | 'error'
  | 'interrupted'
  | 'hook'
  | 'compact'
  | 'compact-micro'
  | 'plan-implement'
  | 'auto-permission'
  | 'cleared'
  | 'history-expired'
  | 'info';

export interface NoticeBlock extends BlockBase {
  kind: 'notice';
  level: 'info' | 'warn' | 'error';
  noticeType: NoticeType;
  text: string;
  detail?: string;
  /** 仅 noticeType==='plan-implement' 使用：作为轮次开头时的结束时间（state 回到 idle 时打上），用于展示耗时分隔 */
  doneTs?: number;
}

export interface FileChangesBlock extends BlockBase {
  kind: 'file-changes';
  inputId?: string;
  files: FileChange[];
}

/** 定时任务增删卡片（由 create_cron / del_cron 成功结果生成） */
export interface CronBlock extends BlockBase {
  kind: 'cron';
  action: 'create' | 'delete';
  taskId: string;
  /** 任务短标题（删除时可能缺省） */
  title?: string;
  /** 人话计划描述，如「每天 09:00」 */
  schedule?: string;
}

/** 日程页：按目录聚合的定时任务（live=worker 存活，列表含非持久化任务；否则来自持久化文件） */
export interface CronGroup {
  workingDir: string;
  projectId?: string;
  projectName: string;
  live: boolean;
  /** 该目录最近活跃的会话（"打开会话"/定位文件用） */
  latestSessionId?: string;
  tasks: CronTask[];
}

/** 定时任务详情（与 core CronTask 字段一致） */
export interface CronTask {
  id: string;
  sessionId?: string;
  schedule: string;
  task: string;
  title?: string;
  repeat: boolean;
  persist: boolean;
  status: boolean;
  /** 持久化任务所在文件（绝对路径，可带 :起始行-结束行） */
  filePath?: string;
  createdAt: number;
  describeCronExpression: string;
  activatedAt: number;
  lastFiredAt?: number;
  nextFireAt: number[];
}

export type Block =
  | UserBlock
  | AssistantBlock
  | ToolBlock
  | PermissionBlock
  | PickBlock
  | PlanExitBlock
  | TodosBlock
  | AgentBlock
  | BranchOriginBlock
  | NoticeBlock
  | FileChangesBlock
  | CronBlock;

// ==================== 会话快照 ====================

export interface SessionSnapshot {
  sessionId: string;
  workingDir: string;
  /** 已应用的最后事件序号 */
  seq: number;
  state: SessionState;
  agentMode: AgentMode;
  permissionLevel: PermissionLevel;
  usage?: Usage;
  todos: TodoItem[];
  blocks: Block[];
  /** 当前轮次的文件改动汇总（state 回到 idle 时落成 file-changes 块） */
  turn: { inputId?: string; files: Record<string, FileChange> } | null;
  /** 当前正在流式输出的主代理消息 id */
  streamingId?: string;
  /** 会话是否已由 core 加载了历史 */
  historyLoaded?: boolean;
  /** quickchat 旁路问答记录（/quickchat），与主消息流独立 */
  quickchats?: QuickchatEntry[];
}

/** quickchat 旁路问答一条记录 */
export interface QuickchatEntry { question: string; content: string; seq: number; ts?: number }

/** 未决交互请求（由快照 blocks 派生） */
export type PendingKind = 'permission' | 'pick' | 'plan-exit';

// ==================== 协议帧 ====================

export interface ReqFrame {
  id: string;
  action: string;
  sessionId?: string;
  payload?: any;
}

export interface ResFrame {
  id: string;
  ok: boolean;
  data?: any;
  error?: string;
}

/** 会话事件帧 */
export interface EventFrame {
  event: string;
  sessionId: string;
  seq: number;
  data: any;
}

/** 进程级 / 服务端合成事件帧（无 sessionId、无 seq）；workingDir=发出事件的 core worker 目录（cron:update 等） */
export interface ProcEventFrame {
  event: string;
  data: any;
  workingDir?: string;
}

export type ServerFrame = ResFrame | EventFrame | ProcEventFrame;

import { DEFINE_SYSTEM_PROMPT } from '../prompt/define'

export type AgentMode = 'Agent' | 'Plan' | 'Design';

// 权限自由度档位（从低到高）
// - Ask：每次动作都询问
// - AutoEdit：项目内文件编辑自动放行，其余仍询问
// - AutoRun：在发出人工权限申请前先做自动判断，安全则放行
export type PermissionLevel = 'Ask' | 'AutoEdit' | 'AutoRun';

export interface SemaCoreConfig {
  workingDir?: string;               // 项目绝对路径
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none'; // 默认 'info'
  stream?: boolean;                  // 流式输出ai响应，默认 是
  thinking?: boolean;                // 流式输出ai响应，默认 否
  systemPrompt?: string;             // 系统提示
  customRules?: string;              // 用户规则
  skipFileEditPermission?: boolean;  // 是否跳过文件编辑权限检查，默认 否
  skipShellExecPermission?: boolean;  // 是否跳过run_shell执行权限检查，默认 否
  skipSkillPermission?: boolean;     // 是否跳过Skill权限检查，默认 否
  skipMCPToolPermission?: boolean;   // 是否跳过MCP工具权限检查，默认 否
  skipFetchUrlPermission?: boolean;  // 是否跳过fetch_url权限检查，默认 否
  enableLLMCache?: boolean;          // 是否开启LLM缓存，默认 否 建议只在重复测试时使用
  useTools?: string[] | null;        // 限定使用的工具（白名单）默认 null 使用所有工具
  disabledTools?: string[] | null;   // 禁用的工具（黑名单）默认 null 不禁用；与 useTools 同时传时优先生效
  agentMode?: AgentMode;             // 默认 'Agent'
  disableTopicDetection?: boolean;   // 是否禁用话题检测，默认 否
  disableBackgroundTasks?: boolean;  // 是否禁止后台任务（Bash后台/Agent后台/超时转后台），默认 否
  maxSessions?: number;              // 同时存在的会话上限，不传则不限制
}

// 支持动态更新的核心配置字段
export type UpdatableCoreConfigKeys = 'stream' | 'thinking' | 'systemPrompt' | 'customRules' | 'skipFileEditPermission' | 'skipShellExecPermission' | 'skipSkillPermission' | 'skipMCPToolPermission' | 'skipFetchUrlPermission' | 'enableLLMCache' | 'disableBackgroundTasks';

// 默认核心配置
export const defaultCoreConfig = {
  stream: false,
  thinking: false,
  skipFileEditPermission: false,
  skipShellExecPermission: false,
  skipSkillPermission: false,
  skipMCPToolPermission: false,
  skipFetchUrlPermission: false,
  systemPrompt: DEFINE_SYSTEM_PROMPT,
  customRules: "- 中文回答",
  enableLLMCache: false,
  disableBackgroundTasks: false,
};

// 可更新的核心配置类型（基于默认配置）
export type UpdatableCoreConfig = Partial<typeof defaultCoreConfig>;

export interface ModelConfig {
  provider: string;
  modelName: string;
  baseURL: string;
  apiKey: string;
  maxTokens: number;
  contextLength: number;
  adapt: import('./model').AdapterType;
}

export interface TaskConfig {
  main: string;
  quick: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  ownedBy?: string;
  key_doc_url?: string;
}

export interface FetchModelsParams {
  provider?: string;
  baseURL: string;
  apiKey: string;
  adapt: import('./model').AdapterType;
  modelsUrl?: string;
}

export interface FetchModelsResult {
  success: boolean;
  models?: ModelInfo[];
  message?: string;
  curlCommand?: string;
}

// API 连接测试结果接口
export interface ApiTestResult {
  success: boolean;
  message: string;
  curlCommand?: string;
}

// API 连接测试参数接口
export interface ApiTestParams {
  provider?: string;
  baseURL: string;
  apiKey: string;
  modelName: string;
  adapt: import('./model').AdapterType;
}

// 模型更新数据接口
export interface ModelUpdateData {
  modelName: string;
  modelList: string[];
  taskConfig: {
    main: string;
    quick: string;
  };
}

// 文件引用信息
export interface FileReferenceInfo {
  type: 'file' | 'dir'
  name: string
  content: string
}

// 工具信息类型
export interface ToolInfo {
  name: string
  description: string
  status: 'enable' | 'disable'
}

// 导出 command 相关类型
export type {
  CommandScope,
  CommandConfig,
} from './command';

// 导出 skill 相关类型
export type {
  SkillScope,
  SkillConfig,
} from './skill';

// 导出 design 相关类型
export type {
  DesignSkillInfo,
  DesignSystemInfo,
  DesignSystemColor,
} from './design';

// 导出 agent 相关类型
export type {
  AgentConfig,
  AgentScope
} from './agent';

export { MAIN_AGENT_ID  } from '../manager/StateManager';

// 导出 plugin 相关类型
export type {
  PluginScopeKind,
  MarketplacePluginsInfo
} from './plugin';

// 导出 MCP 相关类型
export type {
  MCPServerConfig,
  MCPServerInfo
} from './mcp';

// 导出 Mem 相关类型
export type {
  MemoryConfig
} from './memory';

// 导出 Rule 相关类型
export type {
  RuleScope,
  RuleConfig
} from './rule';

// 导出 Task 相关类型
export type {
  TaskListItem
} from './task';

// 导出 TodoTask 相关类型
export type {
  TodoItem,
  TodoTaskStatus,
  TodoTask,
} from './todoTask';

// 导出 Cron 相关类型
export type {
  CronTask,
  CronTaskFile,
} from './cron';

// 导出工具名常量
export {
  TOOL_NAME_VIEW_FILE,
  TOOL_NAME_RUN_SHELL,
  TOOL_NAME_PEEK_BG_JOB,
  TOOL_NAME_STOP_BG_JOB,
  TOOL_NAME_DEL_CRON,
  TOOL_NAME_LIST_CRONS,
  TOOL_NAME_CREATE_TODO,
  TOOL_NAME_LIST_TODOS,
  TOOL_NAME_GET_TODO,
  TOOL_NAME_UPDATE_TODO,
  TOOL_NAME_CREATE_CRON,
  TOOL_NAME_PICK_OPTION,
  TOOL_NAME_PLAN_TO_AGENT,
  TOOL_NAME_FETCH_URL,
  TOOL_NAME_SEARCH_FILES,
  TOOL_NAME_SEARCH_CONTENT,
  TOOL_NAME_EDIT_NOTEBOOK,
  TOOL_NAME_SKILL,
  TOOL_NAME_SUB_AGENT,
  TOOL_NAME_WRITE_FILE,
  TOOL_NAME_PATCH_FILE,
} from '../prompt/tool';

export type { CreateSessionOptions, CreateSessionResult } from './session';


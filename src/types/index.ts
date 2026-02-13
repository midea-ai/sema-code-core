export interface SemaCoreConfig {
  workingDir?: string; // 项目绝对路径
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none'; // 默认 'info'
  stream?: boolean; // 流式输出ai响应，默认 是
  thinking?: boolean; // 流式输出ai响应，默认 否
  systemPrompt?: string;  // 系统提示
  customRules?: string;  // 用户规则
  skipFileEditPermission?: boolean; // 是否跳过文件编辑权限检查，默认 否
  skipBashExecPermission?: boolean; // 是否跳过bash执行权限检查，默认 否
  skipSkillPermission?: boolean; // 是否跳过Skill权限检查，默认 否
  skipMCPToolPermission?: boolean; // 是否跳过MCP工具权限检查，默认 否
  enableLLMCache?: boolean; // 是否开启LLM缓存，默认 否 只有测试时使用
  useTools?: string[] | null; // 限定使用的工具 默认 null 使用所有工具
  agentMode?: 'Agent' | 'Plan' ; // 默认 'Agent'
}

// 支持动态更新的核心配置字段
export type UpdatableCoreConfigKeys = 'stream' | 'thinking' | 'systemPrompt' | 'customRules' | 'skipFileEditPermission' | 'skipBashExecPermission' | 'skipSkillPermission' | 'skipMCPToolPermission' | 'enableLLMCache';

// 默认核心配置
export const defaultCoreConfig = {
  stream: false,
  thinking: false,
  skipFileEditPermission: true,
  skipBashExecPermission: false,
  skipSkillPermission: false,
  skipMCPToolPermission: false,
  systemPrompt: "You are Sema, AIRC's Agent AI for coding.",
  customRules: "- 中文回答",
  enableLLMCache: false
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

// 导出 MCP 相关类型
export type {
  MCPTransportType,
  MCPScopeType,
  MCPServerConfig,
  MCPToolDefinition,
  MCPResourceDefinition,
  MCPPromptDefinition,
  MCPServerCapabilities,
  MCPServerStatus,
  MCPServerInfo
} from './mcp';

// 导出 skill 相关类型
export type {
  SkillMetadata,
  Skill,
  SkillLoaderConfig,
  SkillRegistry,
  SkillInfo
} from './skill';

// 导出 agent 相关类型
export type {
  AgentConfig,
  AgentInfo,
  AgentLocate
} from './agent';

export { MAIN_AGENT_ID  } from '../manager/StateManager';
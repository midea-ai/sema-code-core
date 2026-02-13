import { SemaCoreConfig, ModelConfig, TaskConfig, FetchModelsParams, FetchModelsResult, ApiTestParams, ApiTestResult, ModelUpdateData, UpdatableCoreConfigKeys, UpdatableCoreConfig } from '../types';
import { FileReferenceInfo, ToolInfo } from '../types/index';
import { MCPServerConfig, MCPScopeType, MCPServerInfo } from '../types/mcp';
import { SkillInfo } from '../types/skill';
import { AgentInfo, AgentConfig } from '../types/agent';
import { ToolPermissionResponse, AskQuestionResponseData, PlanExitResponseData } from '../events/types';
import { fetchModels, testApiConnection } from '../services/api/apiUtil';
import { getMCPManager, initMCPManager } from '../services/mcp/MCPManager';
import { getSkillsInfo } from '../services/skill/skillRegistry';
import { getAgentsInfo, addAgentConf } from '../services/agents/agentsManager';
import { getCachedCustomCommands, reloadCustomCommands as reloadCustomCommandsImpl } from '../services/plugins/customCommands';
import { CustomCommand } from '../types/command';
import { SemaEngine } from './SemaEngine';
import { getConfManager } from '../manager/ConfManager';
import { getModelManager } from '../manager/ModelManager';
import { getToolInfos } from '../tools/base/tools';
import { logInfo } from '../util/log';

/**
 * Sema 核心 API 类
 * 提供简洁的公共接口，内部委托给 SemaEngine 处理业务逻辑
 */
export class SemaCore {
  private readonly engine: SemaEngine;
  private configPromise: Promise<void> | null = null;

  constructor(config?: SemaCoreConfig) {
    this.configPromise = getConfManager().setCoreConfig(config || {});
    this.engine = new SemaEngine();

    this.configPromise = this.configPromise.then(async () => {
      await Promise.all([
        initMCPManager()
      ]);
    });
    logInfo(`初始化SemaCore: ${JSON.stringify(config, null, 2)}`)
  }

  // ==================== 事件接口 ====================
  // 监听事件接口 - 暴露所有监听能力
  on = <T>(event: string, listener: (data: T) => void) => (this.engine.on(event, listener), this);
  once = <T>(event: string, listener: (data: T) => void) => (this.engine.once(event, listener), this);
  off = <T>(event: string, listener: (data: T) => void) => (this.engine.off(event, listener), this);

  // 权限响应接口 - 只暴露必要的发送能力
  respondToToolPermission = (response: ToolPermissionResponse) =>
    this.engine.emit('tool:permission:response', response);
  respondToAskQuestion = (response: AskQuestionResponseData) =>
    this.engine.emit('ask:question:response', response);
  respondToPlanExit = (response: PlanExitResponseData) =>
    this.engine.emit('plan:exit:response', response);

  // ==================== 会话 ====================
  // 异步操作，通过事件通知结果
  createSession = async (sessionId?: string) => {
    // 等待配置设置完成
    if (this.configPromise) {
      await this.configPromise;
      this.configPromise = null;
    }
    return this.engine.createSession(sessionId);
  };
  processUserInput = (input: string, originalInput?: string): void => this.engine.processUserInput(input, originalInput);

  // ==================== 中断 ====================
  // 同步操作，立即执行
  interruptSession = () => this.engine.interruptSession();

  // ==================== 模型管理 ====================
  // 异步操作，返回结果并通过 model:update 事件通知
  addModel = (config: ModelConfig, skipValidation?: boolean): Promise<ModelUpdateData> => getModelManager().addNewModel(config, skipValidation);
  delModel = (ModelName: string): Promise<ModelUpdateData> => getModelManager().deleteModel(ModelName);
  switchModel = (ModelName: string): Promise<ModelUpdateData> => getModelManager().switchCurrentModel(ModelName);
  applyTaskModel = (config: TaskConfig): Promise<ModelUpdateData> => getModelManager().applyTaskModelConfig(config);
  getModelData = (): Promise<ModelUpdateData> => getModelManager().getModelData();

  // ==================== 配置管理 ====================
  // 更新核心配置
  updateCoreConfByKey = <K extends UpdatableCoreConfigKeys>(key: K, value: SemaCoreConfig[K]): void => getConfManager().updateCoreConfByKey(key, value);
  updateCoreConfig = (config: UpdatableCoreConfig): void => getConfManager().updateCoreConfig(config);
  updateUseTools = (toolNames: string[] | null): void => getConfManager().updateUseTools(toolNames);
  updateAgentMode = (mode: 'Agent' | 'Plan'): void => this.engine.updateAgentMode(mode);
  getToolInfos = (): ToolInfo[] => getToolInfos();

  // ==================== 工具API ====================
  // 独立的工具函数，不依赖会话状态
  fetchAvailableModels = (params: FetchModelsParams): Promise<FetchModelsResult> => fetchModels(params);
  testApiConnection = (params: ApiTestParams): Promise<ApiTestResult> => testApiConnection(params);

  // ==================== MCP 管理 ====================
  addOrUpdateMCPServer = (config: MCPServerConfig, scope: MCPScopeType): Promise<MCPServerInfo> => getMCPManager().addOrUpdateServer(config, scope);
  removeMCPServer = (name: string, scope: MCPScopeType): Promise<boolean> => getMCPManager().removeServer(name, scope);
  getMCPServerConfigs = (): Map<MCPScopeType, MCPServerInfo[]>  => getMCPManager().getMCPServerConfigs();
  connectMCPServer = (name: string): Promise<MCPServerInfo> => getMCPManager().connectMCPServer(name);
  updateMCPUseTools = (name: string, toolNames: string[] | null): boolean => getMCPManager().updateMCPUseTools(name, toolNames);

  // ==================== Skill 管理 ====================
  getSkillsInfo = (): SkillInfo[] => getSkillsInfo();

  // ==================== Agents 管理 ====================
  // getAgentsConfs = (): AgentConfig[] => getAgentsConfs();
  getAgentsInfo = (): AgentInfo[] => getAgentsInfo();
  addAgentConf = (agentConf: AgentConfig): Promise<boolean> => addAgentConf(agentConf);

  // ==================== Custom Commands 管理 ====================
  getCustomCommands = (): Promise<CustomCommand[]> => getCachedCustomCommands();
  reloadCustomCommands = (): void => reloadCustomCommandsImpl();

  // ==================== 资源管理 ====================
  // 清理所有资源并停止 Sema 核心服务
  dispose = async () => {
    await getMCPManager().dispose();
    this.engine.dispose();
  };

}
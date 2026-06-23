import { SemaCoreConfig, ModelConfig, TaskConfig, FetchModelsParams, FetchModelsResult, ApiTestParams, ApiTestResult, ModelUpdateData, UpdatableCoreConfigKeys, UpdatableCoreConfig } from '../types';
import { ToolInfo } from '../types/index';
import { fetchModels, testApiConnection } from '../services/api/apiUtil';
import { getPluginsManager } from '../services/plugins/pluginsManager';
import { PluginScopeKind, MarketplacePluginsInfo } from '../types/plugin';
import { getAgentsManager } from '../services/agents/agentsManager';
import { AgentConfig } from '../types/agent';
import { getSkillsManager } from '../services/skills/skillsManager';
import { SkillConfig } from '../types/skill';
import { getCommandsManager } from '../services/commands/commandsManager';
import { CommandConfig } from '../types/command';
import { getMCPManager } from '../services/mcp/MCPManager';
import { MCPServerConfig, MCPServerInfo } from '../types/mcp';
import { getMemoryManager } from '../services/memory/memManager';
import { MemoryConfig } from '../types/memory';
import { getRuleManager } from '../services/rules/rulesManager';
import { RuleConfig } from '../types/rule';
import { getDesignManager } from '../services/design/designManager';
import { DesignSkillInfo, DesignSystemInfo } from '../types/design';
import { getTaskManager } from '../manager/TaskManager';
import { getCronManager } from '../manager/CronManager';
import { CronTask } from '../types/cron';
import { CreateSessionOptions, CreateSessionResult } from '../types/session';
import { getSessionPool } from './SessionPool';
import { getConfManager } from '../manager/ConfManager';
import { getModelManager } from '../manager/ModelManager';
import { getAllBuiltinToolInfos } from '../tools/base/tools';
import { inferAdapter } from '../util/adapter';
import { getEventBus } from '../events/EventSystem';
import { ProcessEvent } from '../events/types';
import { logInfo } from '../util/log';

/**
 * Sema 核心 API 类（进程级）
 * 管理会话池与全局配置；会话级交互见 SemaSession。
 */
export class SemaCore {
  private configPromise: Promise<void> | null = null;
  /** 本 Core 注册的进程级事件监听器，dispose 时统一摘除 */
  private procListeners: Array<{ event: ProcessEvent; fn: Function }> = [];

  constructor(config?: SemaCoreConfig) {
    this.configPromise = getConfManager().setCoreConfig(config || {});

    this.configPromise = this.configPromise.then(async () => {
      // 触发单例初始化，后台加载 市场插件信息、memory 信息、rule 信息
      getPluginsManager();
      getMemoryManager();
      getRuleManager();
    });
    logInfo(`初始化SemaCore: ${JSON.stringify(config, null, 2)}`)
  }

  // ==================== 会话池（实现见 SessionPool）====================
  createSession = async (opts: CreateSessionOptions = {}): Promise<CreateSessionResult> => {
    if (this.configPromise) {
      try {
        await this.configPromise;
      } catch (e) {
        // 配置初始化失败（如 workingDir 无效）：返回明确错误而非抛异常
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      } finally {
        this.configPromise = null;
      }
    }
    return getSessionPool().createSession(opts);
  };

  getSession = (sessionId: string) => getSessionPool().getSession(sessionId);
  listSessions = (): string[] => getSessionPool().listSessions();
  setActiveSession = (sessionId: string): boolean => getSessionPool().setActiveSession(sessionId);
  closeSession = (sessionId: string): boolean => getSessionPool().closeSession(sessionId);

  // ==================== 进程级事件（MCP / Cron 等全局事件）====================
  /**
   * 订阅进程级事件（如 `cron:update` / `mcp:server:status`）。
   * 注册为全局监听器（不绑定 sessionId），生命周期跟随 Core，dispose 时自动摘除。
   * 会话级对话事件请使用 SemaSession.on。
   */
  on = <T>(event: ProcessEvent, listener: (data: T) => void): this => {
    getEventBus().on(event, listener, null);
    this.procListeners.push({ event, fn: listener });
    return this;
  };
  once = <T>(event: ProcessEvent, listener: (data: T) => void): this => {
    const wrapper = (data: T) => {
      this.off(event, wrapper);
      listener(data);
    };
    return this.on(event, wrapper);
  };
  off = <T>(event: ProcessEvent, listener: (data: T) => void): this => {
    getEventBus().off(event, listener);
    this.procListeners = this.procListeners.filter(e => e.fn !== listener);
    return this;
  };

  // ==================== 模型管理 ====================
  addModel = (config: ModelConfig, skipValidation?: boolean): Promise<ModelUpdateData> => getModelManager().addNewModel(config, skipValidation);
  delModel = (ModelName: string): Promise<ModelUpdateData> => getModelManager().deleteModel(ModelName);
  switchModel = (ModelName: string): Promise<ModelUpdateData> => getModelManager().switchCurrentModel(ModelName);
  applyTaskModel = (config: TaskConfig): Promise<ModelUpdateData> => getModelManager().applyTaskModelConfig(config);
  getModelData = (): Promise<ModelUpdateData> => getModelManager().getModelData();

  // ==================== 配置管理（全局） ====================
  updateCoreConfByKey = <K extends UpdatableCoreConfigKeys>(key: K, value: SemaCoreConfig[K]): void => {
    getConfManager().updateCoreConfByKey(key, value);
  };
  updateCoreConfig = (config: UpdatableCoreConfig): void => {
    getConfManager().updateCoreConfig(config);
  };
  // 更新全局禁用工具（黑名单），内部转换为白名单写入 useTools
  updateDisabledTools = (toolNames: string[] | null): void => {
    getConfManager().updateDisabledTools(toolNames);
  };

  // 全局默认工具信息
  getToolInfos = (): ToolInfo[] => getAllBuiltinToolInfos();

  // ==================== 工具API ====================
  fetchAvailableModels = (params: FetchModelsParams): Promise<FetchModelsResult> => fetchModels(params);
  testApiConnection = (params: ApiTestParams): Promise<ApiTestResult> => testApiConnection(params);
  getModelAdapter = (provider: string, modelName: string, baseURL: string) => inferAdapter({ provider, modelName, baseURL });

  // ==================== 插件市场管理 ====================
  addMarketplaceFromGit = (repo: string): Promise<MarketplacePluginsInfo> => getPluginsManager().addMarketplaceFromGit(repo);
  addMarketplaceFromDirectory = (dirPath: string): Promise<MarketplacePluginsInfo> => getPluginsManager().addMarketplaceFromDirectory(dirPath);
  updateMarketplace = (marketplaceName: string): Promise<MarketplacePluginsInfo> => getPluginsManager().updateMarketplace(marketplaceName);
  removeMarketplace = (marketplaceName: string): Promise<MarketplacePluginsInfo> => getPluginsManager().removeMarketplace(marketplaceName);
  installPlugin = (pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().installPlugin(pluginName, marketplaceName, scope, projectPath);
  uninstallPlugin = (pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().uninstallPlugin(pluginName, marketplaceName, scope, projectPath);
  enablePlugin = (pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().enablePlugin(pluginName, marketplaceName, scope, projectPath);
  disablePlugin = (pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().disablePlugin(pluginName, marketplaceName, scope, projectPath);
  updatePlugin = (pluginName: string, marketplaceName: string, scope: PluginScopeKind, projectPath?: string): Promise<MarketplacePluginsInfo> => getPluginsManager().updatePlugin(pluginName, marketplaceName, scope, projectPath);
  refreshMarketplacePluginsInfo = (): Promise<MarketplacePluginsInfo> => getPluginsManager().refreshMarketplacePluginsInfo();
  getMarketplacePluginsInfo = (): Promise<MarketplacePluginsInfo> => getPluginsManager().getMarketplacePluginsInfo();

  // ==================== Agents 管理 ====================
  getAgentsInfo = (concise?: boolean, refresh?: boolean): Promise<AgentConfig[]> => getAgentsManager().getAgentsInfo(concise, refresh);
  addAgentConf = (agentConf: AgentConfig): Promise<AgentConfig[]> => getAgentsManager().addAgentConf(agentConf);
  removeAgentConf = (name: string): Promise<AgentConfig[]> => getAgentsManager().removeAgentConf(name);

  // ==================== Skills 管理 ====================
  getSkillsInfo = (concise?: boolean, refresh?: boolean): Promise<SkillConfig[]> => getSkillsManager().getSkillsInfo(concise, refresh);
  removeSkillConf = (name: string): Promise<SkillConfig[]> => getSkillsManager().removeSkillConf(name);

  // ==================== Commands 管理 ====================
  getCommandsInfo = (concise?: boolean, refresh?: boolean): Promise<CommandConfig[]> => getCommandsManager().getCommandsInfo(concise, refresh);
  addCommandConf = (commandConf: CommandConfig): Promise<CommandConfig[]> => getCommandsManager().addCommandConf(commandConf);
  removeCommandConf = (name: string): Promise<CommandConfig[]> => getCommandsManager().removeCommandConf(name);

  // ==================== MCP 管理 ====================
  getMCPServerInfo = (): Promise<MCPServerInfo[]> => getMCPManager().getMCPServerConfigs();
  refreshMCPServerInfo = (): Promise<MCPServerInfo[]> => getMCPManager().refreshMCPServerConfigs();
  addMCPServer = (mcpConfig: MCPServerConfig): Promise<MCPServerInfo[]> => getMCPManager().addMCPServer(mcpConfig);
  removeMCPServer = (name: string): Promise<MCPServerInfo[]> => getMCPManager().removeMCPServer(name);
  reconnectMCPServer = (name: string): Promise<MCPServerInfo[]> => getMCPManager().reconnectMCPServer(name);
  disableMCPServer = (name: string): Promise<MCPServerInfo[]> => getMCPManager().disableMCPServer(name);
  enableMCPServer = (name: string): Promise<MCPServerInfo[]> => getMCPManager().enableMCPServer(name);
  updateMCPUseTools = (name: string, toolNames: string[]): Promise<MCPServerInfo[]> => getMCPManager().updateMCPUseTools(name, toolNames);

  // ==================== Memory 管理 ====================
  getMemoryInfo = (refresh?: boolean): Promise<MemoryConfig | null> => getMemoryManager().getMemoryInfo(refresh);

  // ==================== Rule 管理 ====================
  getRuleInfo = (refresh?: boolean): Promise<RuleConfig | null> => getRuleManager().getRuleInfo(refresh);

  // ==================== Design 设计资源 ====================
  getDesignSkillsInfo = (refresh?: boolean): Promise<DesignSkillInfo[]> => getDesignManager().getDesignSkillsInfo(refresh);
  getDesignSystemsInfo = (refresh?: boolean): Promise<DesignSystemInfo[]> => getDesignManager().getDesignSystemsInfo(refresh);

  // ==================== Cron 定时任务管理（全局） ====================
  getCronTasks = (): Promise<CronTask[]> => getCronManager().getTaskList();
  deleteCronTask = (id: string): boolean => getCronManager().deleteTask(id);
  enableCronTask = (id: string): boolean => getCronManager().enableTask(id);
  disableCronTask = (id: string): boolean => getCronManager().disableTask(id);

  // ==================== 资源管理（进程级） ====================
  dispose = async () => {
    // 摘除进程级事件监听器
    this.procListeners.forEach(({ event, fn }) => getEventBus().off(event, fn as any));
    this.procListeners = [];

    // 关闭所有会话
    getSessionPool().disposeAll();

    // 释放全局单例
    getCronManager().dispose();
    getTaskManager().dispose();
    getPluginsManager().dispose();
    getMemoryManager().dispose();
    getRuleManager().dispose();
    getDesignManager().dispose();
  };
}

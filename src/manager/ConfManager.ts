import * as fs from 'fs';
import * as path from 'path';
import { SemaCoreConfig, UpdatableCoreConfigKeys, UpdatableCoreConfig, defaultCoreConfig } from '../types/index'
import { ProjectConfig, GlobalProjectConfig } from '../types/config'
import { PROJECT_LENGTH_LIMIT, PROJECT_HISTORY_LENGTH_LIMIT } from '../constants/config'
import { getProjectConfigFilePath} from '../util/savePath';
import { getCwd, setCwd, setOriginalCwd } from '../util/cwd';
import { getCurrentLocalTimeString } from '../util/time';
import { logWarn, logError, logInfo, setLogLevel } from '../util/log';

/**
 * 配置管理器
 * 专门负责系统配置和项目配置的加载、保存和管理
 */
export class ConfigManager {
  private globalConfig: GlobalProjectConfig = {};
  private readonly configPath: string;

  private coreConfig: SemaCoreConfig | null = null;
  private projectConfig: ProjectConfig | null = null;
  private projecName: string | null = null;

  constructor(globalConfig: GlobalProjectConfig) {
    this.configPath = getProjectConfigFilePath();
    this.globalConfig = globalConfig;
  }

  /**
   * 设置核心配置
   */
  async setCoreConfig(config: SemaCoreConfig): Promise<void> {
    this.coreConfig = config;

    // 设置日志级别（优先设置，确保后续日志能正确过滤）
    setLogLevel(config.logLevel || 'info');

    // 如果 workingDir 未提供，使用当前工作目录
    const workingDir = config.workingDir || getCwd();
    this.projecName = workingDir;

    if (config.workingDir) {
      // 设置原始工作目录（静态值，一旦设置就不会改变）
      setOriginalCwd(workingDir);
      // 设置当前工作目录（动态值，会随着shell目录切换而更新）
      await setCwd(workingDir);
      // logInfo(`工作目录设置完成，当前目录: ${getCwd()}`);
    } else {
      logInfo(`使用默认工作目录: ${workingDir}`);
    }

    // 初始化项目配置（如果不存在）
    const isNewProject = this.initProjectConfig(workingDir);

    // 如果是新项目，需要保存配置到文件
    if (isNewProject) {
      this.saveConfig();
    }
  }

  /**
   * 获取核心配置
   */
  getCoreConfig(): SemaCoreConfig | null {
    return this.coreConfig ? { ...this.coreConfig } : null;
  }

  /**
   * 更新核心配置的单个字段
   */
  updateCoreConfByKey<K extends UpdatableCoreConfigKeys>(key: K, value: SemaCoreConfig[K]): void {
    if (!this.coreConfig) {
      throw new Error('核心配置未初始化，请先调用 setCoreConfig');
    }

    // 支持的可更新字段列表
    const allowedKeys: UpdatableCoreConfigKeys[] = [
      'stream',
      'thinking',
      'systemPrompt',
      'customRules',
      'skipFileEditPermission',
      'skipBashExecPermission',
      'skipSkillPermission',
      'skipMCPToolPermission',
      'enableLLMCache'
    ];

    if (!allowedKeys.includes(key)) {
      throw new Error(`不支持更新字段 '${key}'，只支持以下字段: ${allowedKeys.join(', ')}`);
    }

    // 更新核心配置对象
    this.coreConfig = {
      ...this.coreConfig,
      [key]: value
    };

    logInfo(`核心配置已更新: ${String(key)} = ${String(value)}`);
  }

  /**
   * 批量更新核心配置
   */
  updateCoreConfig(config: UpdatableCoreConfig): void {
    if (!this.coreConfig) {
      throw new Error('核心配置未初始化，请先调用 setCoreConfig');
    }

    // 支持的可更新字段列表（从默认配置中获取）
    const allowedKeys = Object.keys(defaultCoreConfig) as UpdatableCoreConfigKeys[];

    // 验证所有传入的字段都是允许更新的
    const configKeys = Object.keys(config) as UpdatableCoreConfigKeys[];
    const invalidKeys = configKeys.filter(key => !allowedKeys.includes(key));

    if (invalidKeys.length > 0) {
      throw new Error(`不支持更新字段: ${invalidKeys.join(', ')}，只支持以下字段: ${allowedKeys.join(', ')}`);
    }

    // 批量更新核心配置对象
    this.coreConfig = {
      ...this.coreConfig,
      ...config
    };

    const updatedFields = configKeys.map(key => `${String(key)} = ${String(config[key])}`).join(', ');
    logInfo(`核心配置批量更新: ${updatedFields}`);
  }

  /**
   * 更新使用的工具列表
   */
  updateUseTools(toolNames: string[] | null): void {
    if (!this.coreConfig) {
      throw new Error('核心配置未初始化，请先调用 setCoreConfig');
    }

    this.coreConfig = {
      ...this.coreConfig,
      useTools: toolNames
    };

    logInfo(`工具列表已更新: ${toolNames ? toolNames.join(', ') : 'null (使用所有工具)'}`);
  }

  /**
   * 更新 Agent 模式
   */
  updateAgentMode(mode: 'Agent' | 'Plan'): void {
    if (!this.coreConfig) {
      throw new Error('核心配置未初始化，请先调用 setCoreConfig');
    }

    this.coreConfig = {
      ...this.coreConfig,
      agentMode: mode
    };

    logInfo(`Agent 模式已更新: ${mode}`);
  }

  /**
   * 获取项目配置
   */
  getProjectConfig(): ProjectConfig | null {
    return this.projectConfig ? { ...this.projectConfig } : null;
  }

  /**
   * 设置项目配置
   */
  setProjectConfig(config: Partial<ProjectConfig>): void {
    if (!this.projectConfig || !this.projecName) {
      throw new Error('项目配置未初始化，请先调用 setCoreConfig');
    }

    // 更新项目配置对象
    this.projectConfig = {
      ...this.projectConfig,
      ...config
    };

    // 如果修改了 history 字段，需要截断到最多30长度
    if (config.history) {
      this.projectConfig.history = this.truncateHistory(config.history);
    }

    // 更新 lastEditTime
    this.projectConfig.lastEditTime = getCurrentLocalTimeString();

    // 更新全局配置中的项目数据
    this.globalConfig[this.projecName] = this.projectConfig;

    // 触发文件写入
    this.saveConfig();
  }

  /**
   * 保存用户输入到项目历史记录
   */
  saveUserInputToHistory(input: string): void {
    if (!this.projectConfig) {
      logWarn('项目配置未初始化，无法保存用户输入到历史记录');
      return;
    }

    try {
      // 将用户输入添加到 history 数组的开头（倒序存储，新的在前面）
      const updatedHistory = [input, ...this.projectConfig.history];

      this.setProjectConfig({
        history: updatedHistory
      });

    } catch (error) {
      logError(`保存用户输入到项目配置历史失败: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * 初始化项目配置
   * @returns 是否是新项目
   */
  private initProjectConfig(namespace: string): boolean {
    let isNewProject = false;

    if (!this.globalConfig[namespace]) {
      this.globalConfig[namespace] = this.createDefaultProjectConfig();
      isNewProject = true;

      // 清理旧项目（保留最多20个）
      this.cleanupOldProjects();
    }

    // 设置当前项目配置
    this.projectConfig = this.globalConfig[namespace];

    return isNewProject;
  }

  /**
 * 创建默认模型配置
 */
  private createDefaultProjectConfig(): ProjectConfig {
    return {
      allowedTools: [],
      history: [],
      lastEditTime: getCurrentLocalTimeString(),
      rules: []
    };
  }

  /**
   * 清理旧项目配置，保留最近的项目
   */
  private cleanupOldProjects(): void {
    const projectEntries = Object.entries(this.globalConfig);

    if (projectEntries.length <= PROJECT_LENGTH_LIMIT) {
      return;
    }

    // 按 lastEditTime 排序
    projectEntries.sort((a, b) => {
      const timeA = new Date(a[1].lastEditTime).getTime();
      const timeB = new Date(b[1].lastEditTime).getTime();
      return timeB - timeA; // 降序，最新的在前
    });

    // 保留前面的
    const projectsToKeep = projectEntries.slice(0, PROJECT_LENGTH_LIMIT);
    this.globalConfig = Object.fromEntries(projectsToKeep);
  }

  /**
   * 截断 history 数组到最大长度
   */
  private truncateHistory(history: string[]): string[] {
    if (history.length > PROJECT_HISTORY_LENGTH_LIMIT) {
      // history 是倒序的，截断后面的（旧的）
      return history.slice(0, PROJECT_HISTORY_LENGTH_LIMIT);
    }
    return history;
  }

  /**
   * 保存项目配置到独立配置文件
   */
  saveConfig(): void {
    try {
      // 确保配置目录存在
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // 直接保存项目配置
      const configContent = JSON.stringify(this.globalConfig, null, 2);
      fs.writeFileSync(this.configPath, configContent, 'utf8');
    } catch (error) {
      throw new Error(`保存配置失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

}

// ===================== 全局配置管理器 =====================

let globalConfigManager: ConfigManager | null = null;

/**
 * 获取全局 ConfigManager 实例（单例模式）
 */
export const getConfManager = (): ConfigManager => {
  try {
    if (!globalConfigManager) {
      let globalConfig = getFileConfig();
      globalConfigManager = new ConfigManager(globalConfig);
    }
    return globalConfigManager;
  } catch (error) {
    return new ConfigManager({});
  }

};

/**
 * 获取项目配置（从独立的项目配置文件中读取）
 */
function getFileConfig(): GlobalProjectConfig {
  try {
    const configPath = getProjectConfigFilePath();
    if (!fs.existsSync(configPath)) {
      return {};
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const projectConfig = JSON.parse(configContent);

    return projectConfig || {};
  } catch (error) {
    logError(error);
    return {};
  }
}
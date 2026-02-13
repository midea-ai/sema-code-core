import * as fs from 'fs';
import * as path from 'path';
import { ModelConfiguration, ModelProfile, ModelPointerType } from '../types/model';
import { ModelConfig, TaskConfig, ModelUpdateData } from '../types';
import { testApiConnection } from '../services/api/apiUtil';
import { getModelConfigFilePath } from '../util/savePath';
import { convertToModelProfile, findModelProfile, parseModelName, createDefaultConfig } from '../util/model';
import { logWarn, logError } from '../util/log';


/**
 * 模型管理器
 * 专门负责模型配置的加载、保存和管理
 */
export class ModelManager {
  private config: ModelConfiguration;
  private readonly configPath: string;

  constructor(initialConfig: ModelConfiguration) {
    this.configPath = getModelConfigFilePath();
    this.config = initialConfig;
  }

  /**
   * 保存模型配置到独立配置文件
   */
  async saveConfig(): Promise<void> {
    try {
      // 确保配置目录存在
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // 直接保存模型配置
      const configContent = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.configPath, configContent, 'utf8');
    } catch (error) {
      throw new Error('保存模型配置失败');
    }
  }

  // ===================== 模型管理接口 =====================

  /**
   * 添加新模型
   * @param config 模型配置
   * @param skipValidation 是否跳过API校验，默认为false
   */
  async addNewModel(config: ModelConfig, skipValidation: boolean = false): Promise<ModelUpdateData> {
    const profile = convertToModelProfile(config);
    const existingModelIndex = this.config.modelProfiles.findIndex(p => p.name === profile.name);

    // 进行API连接测试（可选）
    if (!skipValidation) {
      try {
        const testResult = await testApiConnection({
          provider: config.provider,
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          modelName: config.modelName
        });

        if (!testResult.success) {
          const errorMessage = testResult.curlCommand
            ? `${testResult.message}\n\n调试命令：\n${testResult.curlCommand}`
            : testResult.message;

          throw new Error(`API连接测试失败: ${errorMessage}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('API连接测试失败')) {
          throw error;
        }
        throw new Error(`API校验过程中出现错误: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 如果模型已存在，覆盖现有模型
    if (existingModelIndex !== -1) {
      this.config.modelProfiles[existingModelIndex] = profile;
    } else {
      // 添加新模型
      this.config.modelProfiles.push(profile);
      // 如果这是第一个模型，将所有 modelPointers 设置为该模型
      if (this.config.modelProfiles.length === 1) {
        this.config.modelPointers.main = profile.name;
        this.config.modelPointers.quick = profile.name;
      }
    }

    await this.saveConfig();
    const modelList = this.config.modelProfiles.map(p => p.name);

    return {
      modelName: this.config.modelPointers.main,
      modelList,
      taskConfig: {
        main: this.config.modelPointers.main,
        quick: this.config.modelPointers.quick
      }
    };
  }

  /**
   * 删除模型
   */
  async deleteModel(name: string): Promise<ModelUpdateData> {
    // 解析模型名称格式 "modelName[provider]"
    const parsed = parseModelName(name);
    if (!parsed) {
      throw new Error(`模型名称格式错误: ${name}. 期望格式: "modelName[provider]"`);
    }
    const { modelName, provider } = parsed;
    const modelIndex = this.config.modelProfiles.findIndex(
      profile => profile.provider === provider && profile.modelName === modelName
    );

    if (modelIndex === -1) {
      throw new Error(`模型不存在: ${name}`);
    }

    // 检查是否被模型指针引用
    const pointers = this.config.modelPointers;
    const usedInPointers = Object.entries(pointers).filter(
      ([, value]) => value === name
    );

    if (usedInPointers.length > 0) {
      const pointerNames = usedInPointers.map(([key]) => key).join(', ');
      throw new Error(`模型正在被模型指针使用，无法删除: ${pointerNames}`);
    }

    this.config.modelProfiles.splice(modelIndex, 1);
    await this.saveConfig();
    const modelList = this.config.modelProfiles.map(p => p.name);

    return {
      modelName: this.config.modelPointers.main,
      modelList,
      taskConfig: {
        main: this.config.modelPointers.main,
        quick: this.config.modelPointers.quick
      }
    };
  }

  /**
   * 切换当前模型
   */
  async switchCurrentModel(name: string): Promise<ModelUpdateData> {
    const profile = findModelProfile(name, this.config.modelProfiles);
    if (!profile) {
      throw new Error(`模型不存在: ${name}`);
    }
    this.config.modelPointers.main = name;
    if (!this.config.modelPointers.quick) {
      this.config.modelPointers.quick = name;
    }

    await this.saveConfig();
    const modelList = this.config.modelProfiles.map(p => p.name);

    return {
      modelName: name,
      modelList,
      taskConfig: {
        main: this.config.modelPointers.main,
        quick: this.config.modelPointers.quick
      }
    };
  }

  /**
   * 应用任务模型配置
   */
  async applyTaskModelConfig(config: TaskConfig): Promise<ModelUpdateData> {
    const mainProfile = findModelProfile(config.main, this.config.modelProfiles);
    if (!mainProfile) {
      throw new Error(`main模型不存在: ${config.main}`);
    }
    const quickProfile = findModelProfile(config.quick, this.config.modelProfiles);
    if (!quickProfile) {
      throw new Error(`quick模型不存在: ${config.quick}`);
    }

    this.config.modelPointers.main = config.main;
    this.config.modelPointers.quick = config.quick;
    await this.saveConfig();

    const modelList = this.config.modelProfiles.map(p => p.name);

    return {
      modelName: config.main,
      modelList,
      taskConfig: {
        main: this.config.modelPointers.main,
        quick: this.config.modelPointers.quick
      }
    };
  }

  /**
   * 获取指定类型的模型配置
   */
  getModel(pointer: ModelPointerType): ModelProfile | null {
    const pointerId = this.config.modelPointers?.[pointer];
    if (!pointerId) {
      return null;
    }

    const profile = findModelProfile(pointerId, this.config.modelProfiles);
    return profile || null;
  }

  /**
   * 获取指定类型的模型名称
   */
  getModelName(pointer: ModelPointerType): string | null {
    const profile = this.getModel(pointer);
    return profile ? profile.modelName : null;
  }

  /**
   * 获取当前模型数据
   * @param showModelProfiles 是否包含详细的模型配置信息，默认为false
   */
  async getModelData(): Promise<ModelUpdateData> {
    const modelList = this.config.modelProfiles.map(p => p.name);

    const result: ModelUpdateData = {
      modelName: this.config.modelPointers.main,
      modelList,
      taskConfig: {
        main: this.config.modelPointers.main,
        quick: this.config.modelPointers.quick
      }
    };

    return result;
  }

}

// ===================== 全局模型管理器 =====================

// 全局 ModelManager 实例，避免配置读写竞争条件
let globalModelManager: ModelManager | null = null;

/**
 * 获取全局 ModelManager 实例（单例模式，修复竞争条件）
 */
export const getModelManager = (): ModelManager => {
  try {
    if (!globalModelManager) {
      let config = getModelConfig();
      if (!config) {
        logWarn('没有可用的全局配置，使用空配置创建 ModelManager');
        config = createDefaultConfig()
      } 
      globalModelManager = new ModelManager(config);
    }
    return globalModelManager;
  } catch (error) {
    logError(error);
    return new ModelManager({
      modelProfiles: [],
      modelPointers: { main: '', quick: '' },
    });
  }
};

/**
 * 获取模型配置（从独立的模型配置文件中读取）
 */
function getModelConfig(): ModelConfiguration | null {
  try {
    const configPath = getModelConfigFilePath();
    if (!fs.existsSync(configPath)) {
      return null;
    }

    const configContent = fs.readFileSync(configPath, 'utf8');
    const modelConfig = JSON.parse(configContent);

    return {
      modelProfiles: modelConfig.modelProfiles || [],
      modelPointers: modelConfig.modelPointers || { main: '', quick: '' }
    };
  } catch (error) {
    logError(error);
    return null;
  }
}

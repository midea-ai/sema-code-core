import * as fs from 'fs';
import * as path from 'path';
import { ModelConfiguration, ModelProfile, ModelPointerType, ModelPointers } from '../types/model';
import { ImageModelConfig, ImageModelProfile } from '../types/imageModel';
import { ModelConfig, TaskConfig, ModelUpdateData, ApiTestResult } from '../types';
import { testApiConnection } from '../services/api/apiUtil';
import { getModelConfigFilePath } from '../util/savePath';
import { convertToModelProfile, convertToImageModelProfile, findModelProfile, parseModelName, createDefaultConfig, validateProviderName } from '../util/model';
import { logWarn, logError, logInfo } from '../util/log';
import { t } from '../util/i18n';
import { getEventBus } from '../events/EventSystem';
import { assertScopeEnabled, getHostConfig, isScopeEnabled } from '../conf/hostConfig';
import { hostReadonlyError } from '../util/errors';
import type { ModelsInput } from '../types/host';


/**
 * 模型管理器
 * 专门负责模型配置的加载、保存和管理
 *
 * 来源限定：宿主构造时传入的模型（host 域）合并进内存配置，排在最前、同名盖掉用户的，只读且不落盘；
 * 被盖掉的用户条目不生效但原样留在 model.conf 里，宿主哪天下掉同名模型，用户的配置自动恢复可用。
 * user 域（model.conf）只在 scopes.models 含 'user' 时读写。宿主传的指针是没有用户选择时的缺省值
 */
export class ModelManager {
  private config: ModelConfiguration;
  private readonly configPath: string;
  /** 会话级模型指针覆盖（纯内存、不落盘）：sessionId → { main?, quick? }，值为 profile 名 */
  private sessionOverrides = new Map<string, Partial<ModelPointers>>();
  /**
   * 来自宿主的模型名，只读、不写 model.conf、查询不回传 apiKey。
   * 对话与文生图是两张表、名字规则相同（modelName[provider]），可能重名，所以各记各的
   */
  private readonly hostNames = new Set<string>();
  private readonly hostImageNames = new Set<string>();
  /** model.conf 里与宿主同名而不生效的用户条目：不进内存列表，落盘时原样写回 */
  private readonly shadowedProfiles: ModelProfile[] = [];
  private readonly shadowedImageProfiles: ImageModelProfile[] = [];

  constructor(initialConfig: ModelConfiguration) {
    this.configPath = getModelConfigFilePath();
    this.config = initialConfig;
    this.applyHostModels(getHostConfig().models);
  }

  /**
   * 合并宿主传入的模型：host profile 排最前并盖掉同名的用户 profile（被盖掉的记到 shadowed，落盘时写回）；
   * 指针只在文件里的指针为空或指向不存在的模型时才用宿主的（没传则取第一个）
   */
  private applyHostModels(models: ModelsInput | null): void {
    if (!models) return;
    const hostProfiles = models.profiles.map(convertToModelProfile);
    const hostImages = (models.imageProfiles ?? []).map(convertToImageModelProfile);
    for (const p of hostProfiles) this.hostNames.add(p.name);
    for (const p of hostImages) this.hostImageNames.add(p.name);

    // 只和同一张表里的宿主条目比：宿主的对话模型不盖用户的同名文生图模型，反之亦然
    const split = <T extends { name: string }>(list: T[], hostNames: Set<string>, shadowed: T[]): T[] => {
      const kept: T[] = [];
      for (const p of list) (hostNames.has(p.name) ? shadowed : kept).push(p);
      return kept;
    };
    this.config.modelProfiles = [...hostProfiles, ...split(this.config.modelProfiles, this.hostNames, this.shadowedProfiles)];
    this.config.imageModelProfiles = [...hostImages, ...split(this.imageProfiles, this.hostImageNames, this.shadowedImageProfiles)];

    const pointers = this.config.modelPointers;
    const pick = (hostValue: string | undefined, fallback: string, label: string): string => {
      if (hostValue === undefined) return fallback;
      const list: Array<{ provider: string; modelName: string }> = label === 'image' ? this.imageProfiles : this.config.modelProfiles;
      if (hostValue && !findModelProfile(hostValue, list)) {
        logWarn(`宿主传入的 ${label} 指针 ${hostValue} 不在模型列表中，忽略`);
        return fallback;
      }
      return hostValue;
    };
    if (!pointers.main || !findModelProfile(pointers.main, this.config.modelProfiles)) {
      pointers.main = pick(models.main, hostProfiles[0]?.name ?? '', 'main');
    }
    if (!pointers.quick || !findModelProfile(pointers.quick, this.config.modelProfiles)) {
      pointers.quick = pick(models.quick, pointers.main, 'quick');
    }
    // image 指针与 main / quick 不同：空串是用户明确停用文生图（switchImageModel('')），要保留；
    // 没配置过（缺失）或指向不存在的模型才用宿主的
    const imageUnset = pointers.image === undefined || (pointers.image !== '' && !findModelProfile(pointers.image, this.imageProfiles));
    if (imageUnset) {
      pointers.image = pick(models.image, hostImages[0]?.name ?? '', 'image');
    }
    logInfo(`合并宿主模型 ${this.hostNames.size} 个、文生图模型 ${this.hostImageNames.size} 个，指针 main=${pointers.main} quick=${pointers.quick} image=${pointers.image || '(无)'}`);
  }

  /** 是否宿主的对话模型 */
  private isHost(name: string): boolean {
    return this.hostNames.has(name);
  }

  /** 是否宿主的文生图模型 */
  private isHostImage(name: string): boolean {
    return this.hostImageNames.has(name);
  }

  /**
   * 保存模型配置到独立配置文件。
   * user 域没生效时不落盘（只改内存）；落盘时不写宿主的模型，被宿主盖掉的用户条目原样写回
   */
  async saveConfig(): Promise<void> {
    if (!isScopeEnabled('models', 'user')) return;
    try {
      // 确保配置目录存在
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const persisted: ModelConfiguration = {
        modelProfiles: [...this.config.modelProfiles.filter(p => !this.isHost(p.name)), ...this.shadowedProfiles],
        modelPointers: this.config.modelPointers,
        imageModelProfiles: [...this.imageProfiles.filter(p => !this.isHostImage(p.name)), ...this.shadowedImageProfiles],
      };
      fs.writeFileSync(this.configPath, JSON.stringify(persisted, null, 2), 'utf8');
    } catch (error) {
      throw new Error(t('model.saveFailed'));
    }
  }

  // ===================== 模型管理接口 =====================

  /**
   * 添加新模型
   */
  async addNewModel(config: ModelConfig, skipValidation: boolean = false): Promise<ModelUpdateData> {
    // 写的是 user 域：域没生效报 SCOPE_DISABLED；与宿主模型同名报 HOST_READONLY
    assertScopeEnabled('models', 'user');
    const providerError = validateProviderName(config.provider);
    if (providerError) {
      throw new Error(t('model.invalidProvider', { error: providerError }));
    }
    const profile = convertToModelProfile(config);
    if (this.isHost(profile.name)) throw hostReadonlyError('Model', profile.name);
    const existingModelIndex = this.config.modelProfiles.findIndex(p => p.name === profile.name);

    // 进行API连接测试（可选）
    if (!skipValidation) {
      // 测试结果与测试过程异常分开处理：不靠错误文案识别（文案随 lang 变化）
      let testResult: ApiTestResult;
      try {
        testResult = await testApiConnection({
          provider: config.provider,
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          modelName: config.modelName,
          adapt: config.adapt
        });
      } catch (error) {
        throw new Error(t('model.validateError', { error: error instanceof Error ? error.message : String(error) }));
      }

      if (!testResult.success) {
        const errorMessage = testResult.curlCommand
          ? `${testResult.message}\n\n${t('model.debugCommand')}\n${testResult.curlCommand}`
          : testResult.message;

        throw new Error(t('model.testFailed', { error: errorMessage }));
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
    return this.buildModelData();
  }

  /**
   * 删除模型
   */
  async deleteModel(name: string): Promise<ModelUpdateData> {
    // 解析模型名称格式 "modelName[provider]"
    const parsed = parseModelName(name);
    if (!parsed) {
      throw new Error(t('model.invalidName', { name }));
    }
    const { modelName, provider } = parsed;
    const modelIndex = this.config.modelProfiles.findIndex(
      profile => profile.provider === provider && profile.modelName === modelName
    );

    if (modelIndex === -1) {
      throw new Error(t('model.notFound', { name }));
    }
    if (this.isHost(name)) throw hostReadonlyError('Model', name);

    // 检查是否被模型指针引用（image 指针指向的是文生图模型，同名也不算引用）
    const pointers = this.config.modelPointers;
    const usedInPointers = Object.entries(pointers).filter(
      ([key, value]) => key !== 'image' && value === name
    );

    if (usedInPointers.length > 0) {
      const pointerNames = usedInPointers.map(([key]) => key).join(', ');
      throw new Error(t('model.inUseByPointer', { pointers: pointerNames }));
    }

    this.config.modelProfiles.splice(modelIndex, 1);
    await this.saveConfig();

    // 被会话级覆盖钉住的模型删掉后，这些会话回退全局指针，各自收到一次会话级 model:update
    for (const sessionId of this.clearSessionOverridesOf(name)) {
      getEventBus().emit('model:update', this.buildModelData(sessionId), sessionId);
    }

    return this.buildModelData();
  }

  /**
   * 按 provider + modelName 读取磁盘上的完整 profile，供配置页编辑回填；不存在返回 null。
   * 定位谓词与 deleteModel 一致。宿主模型的 apiKey 不回传（为 ''）
   */
  getModelProfile(provider: string, modelName: string): ModelProfile | null {
    const profile = this.config.modelProfiles.find(p => p.provider === provider && p.modelName === modelName) ?? null;
    return profile && this.isHost(profile.name) ? { ...profile, apiKey: '' } : profile;
  }

  /**
   * 切换当前模型
   */
  async switchCurrentModel(name: string): Promise<ModelUpdateData> {
    const profile = findModelProfile(name, this.config.modelProfiles);
    if (!profile) {
      throw new Error(t('model.notFound', { name }));
    }
    this.config.modelPointers.main = name;
    if (!this.config.modelPointers.quick) {
      this.config.modelPointers.quick = name;
    }

    await this.saveConfig();
    return this.buildModelData();
  }

  /**
   * 应用任务模型配置
   */
  async applyTaskModelConfig(config: TaskConfig): Promise<ModelUpdateData> {
    const mainProfile = findModelProfile(config.main, this.config.modelProfiles);
    if (!mainProfile) {
      throw new Error(t('model.mainNotFound', { name: config.main }));
    }
    const quickProfile = findModelProfile(config.quick, this.config.modelProfiles);
    if (!quickProfile) {
      throw new Error(t('model.quickNotFound', { name: config.quick }));
    }

    this.config.modelPointers.main = config.main;
    this.config.modelPointers.quick = config.quick;
    await this.saveConfig();
    return this.buildModelData();
  }

  // ===================== 文生图模型（进程级，不支持会话级覆盖） =====================

  private get imageProfiles(): ImageModelProfile[] {
    return this.config.imageModelProfiles ?? (this.config.imageModelProfiles = []);
  }

  /**
   * 添加文生图模型，同名覆盖；添加的是第一个文生图模型时 image 指针指向它。
   * 不做连接测试：测一次就要真实出一张图。
   */
  async addImageModel(config: ImageModelConfig): Promise<ModelUpdateData> {
    assertScopeEnabled('models', 'user');
    const providerError = validateProviderName(config.provider);
    if (providerError) {
      throw new Error(t('model.invalidProvider', { error: providerError }));
    }
    const profile = convertToImageModelProfile(config);
    if (this.isHostImage(profile.name)) throw hostReadonlyError('Image model', profile.name);
    const profiles = this.imageProfiles;
    const existingIndex = profiles.findIndex(p => p.name === profile.name);

    if (existingIndex !== -1) {
      profiles[existingIndex] = profile;
    } else {
      profiles.push(profile);
      if (profiles.length === 1) {
        this.config.modelPointers.image = profile.name;
      }
    }

    await this.saveConfig();
    return this.buildModelData();
  }

  /**
   * 删除文生图模型。与对话模型不同，被 image 指针引用时也允许删除：
   * 指针移到剩余的第一个，没有剩余则置空（文生图工具随之不可用）。
   */
  async deleteImageModel(name: string): Promise<ModelUpdateData> {
    const profiles = this.imageProfiles;
    const index = profiles.findIndex(p => p.name === name);
    if (index === -1) {
      throw new Error(t('model.notFound', { name }));
    }
    if (this.isHostImage(name)) throw hostReadonlyError('Image model', name);

    profiles.splice(index, 1);
    if (this.config.modelPointers.image === name) {
      // 没有剩余时去掉指针（回到"没配置过"），不写空串：空串专指用户明确停用，见 applyHostModels
      if (profiles.length > 0) this.config.modelPointers.image = profiles[0].name;
      else delete this.config.modelPointers.image;
    }

    await this.saveConfig();
    return this.buildModelData();
  }

  /**
   * 切换文生图模型指针；传空串表示停用文生图。
   */
  async switchImageModel(name: string): Promise<ModelUpdateData> {
    if (name && !findModelProfile(name, this.imageProfiles)) {
      throw new Error(t('model.notFound', { name }));
    }
    this.config.modelPointers.image = name;
    await this.saveConfig();
    return this.buildModelData();
  }

  /**
   * 按 provider + modelName 读取磁盘上的完整文生图 profile，供配置页编辑回填；不存在返回 null。
   * 宿主模型的 apiKey 不回传（为 ''）
   */
  getImageModelProfile(provider: string, modelName: string): ImageModelProfile | null {
    const profile = this.imageProfiles.find(p => p.provider === provider && p.modelName === modelName) ?? null;
    return profile && this.isHostImage(profile.name) ? { ...profile, apiKey: '' } : profile;
  }

  /**
   * 获取 image 指针当前指向的文生图模型；未配置或指针失效返回 null。
   */
  getImageModel(): ImageModelProfile | null {
    const pointer = this.config.modelPointers?.image;
    if (!pointer) {
      return null;
    }
    return this.imageProfiles.find(p => p.name === pointer) ?? null;
  }

  // ===================== 会话级模型覆盖（仅内存，不持久化） =====================

  /**
   * 设置会话级模型覆盖：只对该会话生效，不写 model.conf。
   * 传入的模型名必须存在于 modelProfiles，否则抛错；main/quick 都未传时不记录。
   */
  setSessionModelOverride(sessionId: string, override: Partial<ModelPointers>): void {
    const result: Partial<ModelPointers> = {};
    for (const pointer of ['main', 'quick'] as ModelPointerType[]) {
      const name = override[pointer];
      if (!name) continue;
      if (!findModelProfile(name, this.config.modelProfiles)) {
        throw new Error(t('model.notFound', { name }));
      }
      result[pointer] = name;
    }
    if (result.main || result.quick) {
      this.sessionOverrides.set(sessionId, result);
    } else {
      this.sessionOverrides.delete(sessionId);
    }
  }

  /** 清除会话级模型覆盖（会话 dispose 时调用） */
  clearSessionModelOverride(sessionId: string): void {
    this.sessionOverrides.delete(sessionId);
  }

  /** 查询会话级模型覆盖（无覆盖返回 undefined） */
  getSessionModelOverride(sessionId: string): Partial<ModelPointers> | undefined {
    return this.sessionOverrides.get(sessionId);
  }

  /**
   * 切换会话级主模型：只改该会话的 main 覆盖，保留已有 quick 覆盖，不写 model.conf。
   * 模型不存在抛错；返回该会话视角的模型数据。
   * 该会话生效的 main 确有变化时在会话总线上 emit 'model:update'，切到已生效的模型不发事件。
   */
  switchSessionModel(sessionId: string, name: string): ModelUpdateData {
    if (!findModelProfile(name, this.config.modelProfiles)) {
      throw new Error(t('model.notFound', { name }));
    }
    const before = this.buildModelData(sessionId).modelName;
    this.sessionOverrides.set(sessionId, { ...this.sessionOverrides.get(sessionId), main: name });
    const data = this.buildModelData(sessionId);
    if (data.modelName !== before) {
      getEventBus().emit('model:update', data, sessionId);
    }
    return data;
  }

  /**
   * 把当前全局 main 指针钉进会话覆盖（只钉 main，quick 不钉），使会话创建后不受全局指针变化影响。
   * 会话已有 main 覆盖、或全局 main 为空/解析不到 profile 时不钉（后者让会话继续跟随全局，
   * 以便先开会话再添加首个模型的场景仍可用）。
   */
  pinSessionMainToGlobal(sessionId: string): void {
    if (this.sessionOverrides.get(sessionId)?.main) return;
    const globalMain = this.config.modelPointers?.main;
    if (!globalMain || !findModelProfile(globalMain, this.config.modelProfiles)) return;
    this.sessionOverrides.set(sessionId, { ...this.sessionOverrides.get(sessionId), main: globalMain });
  }

  /**
   * 清除所有会话中指向该模型的覆盖（deleteModel 内部调用）。
   * 只返回 main 覆盖被清除的 sessionId（这些会话生效的主模型已回退全局，需要发 model:update）；
   * 仅 quick 覆盖被清除的会话不在其列，因为会话视角的 ModelUpdateData 不体现 quick 覆盖，发了也无变化。
   */
  private clearSessionOverridesOf(name: string): string[] {
    const affected: string[] = [];
    for (const [sessionId, override] of this.sessionOverrides) {
      if (override.main === name) {
        delete override.main;
        affected.push(sessionId);
      }
      if (override.quick === name) {
        delete override.quick;
      }
      if (!override.main && !override.quick) {
        this.sessionOverrides.delete(sessionId);
      }
    }
    return affected;
  }

  /**
   * 拼装模型数据：传入 sessionId 时 modelName 与 taskConfig.main 为该会话生效值
   * （覆盖优先，回退全局指针），modelList、taskConfig.quick 与文生图相关字段沿用全局。
   */
  private buildModelData(sessionId?: string): ModelUpdateData {
    const globalMain = this.config.modelPointers.main;
    const overrideMain = sessionId ? this.sessionOverrides.get(sessionId)?.main : undefined;
    const main = overrideMain && findModelProfile(overrideMain, this.config.modelProfiles) ? overrideMain : globalMain;
    return {
      modelName: main,
      modelList: this.config.modelProfiles.map(p => p.name),
      taskConfig: {
        main,
        quick: this.config.modelPointers.quick,
        image: this.config.modelPointers.image || ''
      },
      imageModelList: this.imageProfiles.map(p => p.name),
      hostModels: Array.from(new Set([...this.hostNames, ...this.hostImageNames])),
    };
  }

  /**
   * 获取指定类型的模型配置
   * 传入 sessionId 时优先使用该会话的覆盖；覆盖的模型已不存在则告警并回退全局指针
   */
  getModel(pointer: ModelPointerType, sessionId?: string): ModelProfile | null {
    if (sessionId) {
      const overrideName = this.sessionOverrides.get(sessionId)?.[pointer];
      if (overrideName) {
        const overrideProfile = findModelProfile(overrideName, this.config.modelProfiles);
        if (overrideProfile) {
          return overrideProfile;
        }
        logWarn(`会话 ${sessionId} 的 ${pointer} 模型覆盖 ${overrideName} 已不存在，回退全局配置`);
      }
    }

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
  getModelName(pointer: ModelPointerType, sessionId?: string): string | null {
    const profile = this.getModel(pointer, sessionId);
    return profile ? profile.modelName : null;
  }

  /**
   * 获取当前模型数据；传入 sessionId 时返回该会话视角（main 取会话覆盖，其余沿用全局）
   */
  async getModelData(sessionId?: string): Promise<ModelUpdateData> {
    return this.buildModelData(sessionId);
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
      // user 域没生效时 model.conf 既不读也不写，只有宿主传入的模型
      let config = isScopeEnabled('models', 'user') ? getModelConfig() : null;
      if (!config) {
        if (isScopeEnabled('models', 'user')) logWarn('没有可用的全局配置，使用空配置创建 ModelManager');
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
      modelPointers: modelConfig.modelPointers || { main: '', quick: '' },
      imageModelProfiles: modelConfig.imageModelProfiles || []
    };
  } catch (error) {
    logError(error);
    return null;
  }
}

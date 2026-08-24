import * as path from 'path';
import * as os from 'os';
import { ModelConfiguration, ModelProfile } from '../types/model';
import { ModelConfig } from '../types';
import { logWarn } from './log';


/**
 * 创建默认模型配置
 */
export function createDefaultConfig(): ModelConfiguration {
  return {
    modelProfiles: [],
    modelPointers: {
      main: '',
      quick: ''
    }
  };
}


/**
 * 校验服务商名称（预设与自定义别名统一规则）：
 * 2~20 个字符，小写字母开头，仅含小写字母/数字/短横线，不能以短横线结尾。
 * 合法返回 null，否则返回错误说明。
 */
export function validateProviderName(provider: string): string | null {
  if (provider.length < 2 || provider.length > 20) {
    return '长度需为 2~20 个字符';
  }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(provider)) {
    return '仅支持小写字母、数字和短横线(-)，需以字母开头且不能以短横线结尾';
  }
  return null;
}

export function parseModelName(name: string): { modelName: string; provider: string } | null {
  const match = name.match(/^(.+)\[([^\]]+)\]$/);
  if (!match) {
    logWarn(`Invalid model name format: ${name}. Expected format: "modelName[provider]"`);
    return null;
  }

  const [, modelName, provider] = match;
  return { modelName, provider };
}

/**
 * 查找模型配置
 */
export function findModelProfile(name: string, profiles: ModelProfile[]): ModelProfile | null {
  // 解析 modelName 和 provider
  const parsed = parseModelName(name);
  if (!parsed) {
    return null;
  }

  const { modelName, provider } = parsed;

  // 查找匹配的模型配置
  return profiles.find(profile =>
    profile.provider === provider && profile.modelName === modelName
  ) || null;
}

/**
 * 将 ModelConfig 转换为 ModelProfile
 */
export function convertToModelProfile(config: ModelConfig): ModelProfile {
  return {
    name: `${config.modelName}[${config.provider}]`,
    provider: config.provider,
    modelName: config.modelName,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    maxTokens: config.maxTokens,
    contextLength: config.contextLength,
    adapt: config.adapt
  };
}

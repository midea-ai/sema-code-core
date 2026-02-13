import * as path from 'path';
import * as os from 'os';
import { ModelConfiguration, ModelProfile } from '../types/model';
import { ModelConfig } from '../types';
import { logWarn } from './log';
import { resolveAdapter } from './adapter';


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
 * @param name 模型标识字符串，格式为 "modelName[provider]"，如 "claude-sonnet-4.5[anthropic]"
 * @param profiles 模型配置列表
 * @returns 匹配的模型配置，未找到则返回 null
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
    adapt: resolveAdapter(config.provider, config.modelName)
  };
}

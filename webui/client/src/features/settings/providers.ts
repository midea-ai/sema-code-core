/** 模型提供商预设（对齐参考实现的字段规格） */
import { t } from '../../i18n';

export type AdapterType = 'openai' | 'anthropic';
export type ThinkingHistoryPolicy = 'preserve' | 'current_turn' | 'omit';
export interface ProviderDefaults {
  name: string; baseURL: string; baseURLPlaceholder?: string; defaultModel?: string;
  modelsUrl?: string; apikeyUrl?: string; requiresApiKeyForModelList?: boolean; defaultAdapt?: AdapterType;
  defaultMaxTokens?: number; defaultContextLength?: number; maxTokensOptions?: number[]; contextLengthOptions?: number[];
}

/** 1000000 -> 1M，128000 -> 128k */
export function formatTokenCount(val: number): string {
  if (val >= 1000000) { const m = val / 1000000; return `${Number.isInteger(m) ? m : m.toFixed(1)}M`; }
  return `${Math.round(val / 1000)}k`;
}
export const DEFAULT_MAX_TOKENS_OPTIONS = [16000, 32000, 64000, 128000];
export const DEFAULT_CONTEXT_LENGTH_OPTIONS = [128000, 256000, 512000, 1000000];
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_CONTEXT_LENGTH = 512000;
export const DEFAULT_PROVIDER = 'deepseek';
export const PROVIDER_ORDER = ['custom', 'deepseek', 'minimax', 'glm', 'mimo', 'qwen', 'kimi', 'openrouter', 'anthropic', 'openai'];

export const PROVIDERS: Record<string, ProviderDefaults> = {
  anthropic: { name: 'Anthropic', baseURL: 'https://api.anthropic.com', defaultAdapt: 'anthropic' },
  openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultAdapt: 'openai' },
  kimi: { name: 'Kimi (Moonshot)', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3', apikeyUrl: 'https://platform.moonshot.cn/console/api-keys', defaultAdapt: 'openai' },
  minimax: { name: 'MiniMax', baseURL: 'https://api.minimaxi.com/anthropic', defaultModel: 'MiniMax-M3', apikeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', defaultAdapt: 'anthropic' },
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/anthropic', modelsUrl: 'https://api.deepseek.com/v1/models', defaultModel: 'deepseek-v4-pro', apikeyUrl: 'https://platform.deepseek.com/api_keys', defaultAdapt: 'anthropic' },
  glm: { name: 'GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.2', apikeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', defaultAdapt: 'openai' },
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api', modelsUrl: 'https://openrouter.ai/api/v1/models', defaultModel: 'anthropic/claude-opus-4.6', apikeyUrl: 'https://openrouter.ai/settings/keys', defaultAdapt: 'anthropic' },
  qwen: { name: 'Qwen (Alibaba)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen3.7-max', apikeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?api-key', defaultAdapt: 'openai' },
  mimo: { name: 'MiMo (Xiaomi)', baseURL: 'https://api.xiaomimimo.com/anthropic', modelsUrl: 'https://api.xiaomimimo.com/v1/models', defaultModel: 'mimo-v2.5-pro', apikeyUrl: 'https://platform.xiaomimimo.com/console/api-keys', defaultAdapt: 'anthropic' },
  custom: { name: 'custom', baseURL: '', baseURLPlaceholder: 'https://your-api.com/v1', defaultAdapt: 'openai' },
};

/** 服务商显示名：多数为品牌名原样显示，自定义接口 / 智谱按界面语言取 */
export function providerLabel(k: string): string {
  if (k === 'custom') return t('settings.provider.custom');
  if (k === 'glm') return t('settings.provider.glm');
  return PROVIDERS[k]?.name || k;
}

/** API Key 输入框占位：品牌名套进当前语言模板，智谱 / 阿里云按界面语言取名，其余用通用文案 */
const API_KEY_VENDOR: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', kimi: 'Moonshot', minimax: 'MiniMax', deepseek: 'DeepSeek', openrouter: 'OpenRouter', mimo: 'Xiaomi MiMo' };
export function apiKeyPlaceholder(k: string): string {
  const vendor = k === 'glm' ? t('settings.vendor.zhipu') : k === 'qwen' ? t('settings.vendor.aliyun') : API_KEY_VENDOR[k];
  return vendor ? t('settings.apiKeyPlaceholder', { name: vendor }) : t('settings.apiKeyPlaceholderGeneric');
}

/** 预设服务商名称，自定义别名不允许与之重名（custom 本身除外，等价于不填） */
export const RESERVED_PROVIDERS = PROVIDER_ORDER.filter(key => key !== 'custom');

/** 校验自定义服务商别名：留空合法（回退 custom），否则 2~20 位小写字母/数字/短横线，字母开头、不以短横线结尾 */
export function validateCustomProviderName(name: string): string | null {
  if (!name) return null;
  if (name.length < 2 || name.length > 20) return t('settings.providerName.len');
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) return t('settings.providerName.chars');
  if (RESERVED_PROVIDERS.includes(name)) return t('settings.providerName.reserved', { name });
  return null;
}

/** 模型 profile 名 "modelName[provider]" 解析 */
export function parseProfileName(name: string): { modelName: string; provider: string } {
  const m = /^(.*)\[([^\]]+)\]$/.exec(name);
  return m ? { modelName: m[1], provider: m[2] } : { modelName: name, provider: '' };
}

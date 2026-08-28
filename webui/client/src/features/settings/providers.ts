/** 模型提供商预设（对齐参考实现的字段规格） */
export type AdapterType = 'openai' | 'anthropic';
export interface ProviderDefaults {
  name: string; baseURL: string; baseURLPlaceholder?: string; apiKeyPlaceholder?: string; defaultModel?: string;
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
  anthropic: { name: 'Anthropic', baseURL: 'https://api.anthropic.com', apiKeyPlaceholder: '输入您的 Anthropic API Key', defaultAdapt: 'anthropic' },
  openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKeyPlaceholder: '输入您的 OpenAI API Key', defaultAdapt: 'openai' },
  kimi: { name: 'Kimi (Moonshot)', baseURL: 'https://api.moonshot.cn/v1', apiKeyPlaceholder: '输入您的 Moonshot API Key', defaultModel: 'kimi-k3', apikeyUrl: 'https://platform.moonshot.cn/console/api-keys', defaultAdapt: 'openai' },
  minimax: { name: 'MiniMax', baseURL: 'https://api.minimaxi.com/anthropic', apiKeyPlaceholder: '输入您的 MiniMax API Key', defaultModel: 'MiniMax-M3', apikeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', defaultAdapt: 'anthropic' },
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/anthropic', modelsUrl: 'https://api.deepseek.com/v1/models', apiKeyPlaceholder: '输入您的 DeepSeek API Key', defaultModel: 'deepseek-v4-pro', apikeyUrl: 'https://platform.deepseek.com/api_keys', defaultAdapt: 'anthropic' },
  glm: { name: 'GLM (智谱)', baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyPlaceholder: '输入您的智谱 API Key', defaultModel: 'glm-5.2', apikeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', defaultAdapt: 'openai' },
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api', modelsUrl: 'https://openrouter.ai/api/v1/models', apiKeyPlaceholder: '输入您的 OpenRouter API Key', defaultModel: 'anthropic/claude-opus-4.6', apikeyUrl: 'https://openrouter.ai/settings/keys', defaultAdapt: 'anthropic' },
  qwen: { name: 'Qwen (Alibaba)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyPlaceholder: '输入您的阿里云 API Key', defaultModel: 'qwen3.7-max', apikeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?api-key', defaultAdapt: 'openai' },
  mimo: { name: 'MiMo (Xiaomi)', baseURL: 'https://api.xiaomimimo.com/anthropic', modelsUrl: 'https://api.xiaomimimo.com/v1/models', apiKeyPlaceholder: '输入您的 Xiaomi MiMo API Key', defaultModel: 'mimo-v2.5-pro', apikeyUrl: 'https://platform.xiaomimimo.com/console/api-keys', defaultAdapt: 'anthropic' },
  custom: { name: '自定义 LLM 接口', baseURL: '', baseURLPlaceholder: 'https://your-api.com/v1', apiKeyPlaceholder: '输入您的 API Key', defaultAdapt: 'openai' },
};

/** 预设服务商名称，自定义别名不允许与之重名（custom 本身除外，等价于不填） */
export const RESERVED_PROVIDERS = PROVIDER_ORDER.filter(key => key !== 'custom');

/** 校验自定义服务商别名：留空合法（回退 custom），否则 2~20 位小写字母/数字/短横线，字母开头、不以短横线结尾 */
export function validateCustomProviderName(name: string): string | null {
  if (!name) return null;
  if (name.length < 2 || name.length > 20) return '长度需为 2~20 个字符';
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) return '仅支持小写字母、数字和短横线(-)，需以字母开头且不能以短横线结尾';
  if (RESERVED_PROVIDERS.includes(name)) return `"${name}" 是预设服务商名称，请换一个`;
  return null;
}

/** 模型 profile 名 "modelName[provider]" 解析 */
export function parseProfileName(name: string): { modelName: string; provider: string } {
  const m = /^(.*)\[([^\]]+)\]$/.exec(name);
  return m ? { modelName: m[1], provider: m[2] } : { modelName: name, provider: '' };
}

/** 模型提供商预设（对齐参考实现的字段规格） */
import { t } from '../../i18n';

export type AdapterType = 'openai' | 'anthropic';
export type ThinkingHistoryPolicy = 'preserve' | 'current_turn' | 'omit';
export interface ProviderDefaults {
  name: string; baseURL: string; baseURLPlaceholder?: string; defaultModel?: string;
  modelsUrl?: string; apikeyUrl?: string; requiresApiKeyForModelList?: boolean; defaultAdapt?: AdapterType;
  presetModels?: { id: string; name: string }[];  // 内置模型列表：无 modelsUrl 时直接使用，有 modelsUrl 时作为远端获取失败的兜底
  defaultMaxTokens?: number; defaultContextLength?: number; maxTokensOptions?: number[]; contextLengthOptions?: number[];
  defaultThinkingHistoryPolicy?: ThinkingHistoryPolicy;  // 缺省 preserve
}

/** 1000000 -> 1M，128000 -> 128k */
export function formatTokenCount(val: number): string {
  if (val >= 1000000) { const m = val / 1000000; return `${Number.isInteger(m) ? m : m.toFixed(1)}M`; }
  return `${Math.round(val / 1000)}k`;
}
export const DEFAULT_MAX_TOKENS_OPTIONS = [16000, 32000, 64000, 128000];
export const DEFAULT_CONTEXT_LENGTH_OPTIONS = [128000, 256000, 512000, 1000000];
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_CONTEXT_LENGTH = 1000000;
export const DEFAULT_PROVIDER = 'deepseek';
export const PROVIDER_ORDER = ['custom', 'deepseek', 'minimax', 'glm', 'mimo', 'qwen', 'kimi', 'volcengine', 'openrouter', 'anthropic', 'openai'];

export const PROVIDERS: Record<string, ProviderDefaults> = {
  // 官方 Models API 默认一页只返回 20 条，带 limit 一次拉全；内置列表作为远端获取失败的兜底
  anthropic: { name: 'Anthropic', baseURL: 'https://api.anthropic.com', modelsUrl: 'https://api.anthropic.com/v1/models?limit=1000', defaultAdapt: 'anthropic', presetModels: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }, { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' }, { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }] },
  openai: { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', defaultAdapt: 'openai' },
  kimi: { name: 'Kimi (Moonshot)', baseURL: 'https://api.moonshot.cn/v1', defaultModel: 'kimi-k3', apikeyUrl: 'https://platform.moonshot.cn/console/api-keys', defaultAdapt: 'openai', defaultThinkingHistoryPolicy: 'current_turn' },
  // 官方 /anthropic/v1/models 只认 x-api-key（core 拉取时 Anthropic 适配会带上）；内置列表作为兜底
  minimax: { name: 'MiniMax', baseURL: 'https://api.minimaxi.com/anthropic', modelsUrl: 'https://api.minimaxi.com/anthropic/v1/models', defaultModel: 'MiniMax-M3', apikeyUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', defaultAdapt: 'anthropic', defaultThinkingHistoryPolicy: 'current_turn', presetModels: [{ id: 'MiniMax-M3', name: 'MiniMax-M3' }] },
  // 火山方舟按量付费通用地址（OpenAI 协议）；Coding Plan 用户可改为 https://ark.cn-beijing.volces.com/api/coding 并切 Anthropic 适配。
  // 方舟没有模型列表接口，使用内置列表（来源：方舟文档「模型列表」文本生成模型）
  volcengine: {
    name: 'Volcengine (火山引擎)', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: 'doubao-seed-2-1-pro-260915',
    apikeyUrl: 'https://ark.volcengine.com/region:cn-beijing/apiKey', defaultAdapt: 'openai', defaultThinkingHistoryPolicy: 'current_turn',
    presetModels: [
      { id: 'doubao-seed-2-1-pro-260915', name: 'Doubao Seed 2.1 Pro' },
      { id: 'doubao-seed-2-1-lite-260915', name: 'Doubao Seed 2.1 Lite' },
      { id: 'doubao-seed-2-1-turbo-260628', name: 'Doubao Seed 2.1 Turbo' },
    ],
  },
  deepseek: { name: 'DeepSeek', baseURL: 'https://api.deepseek.com/anthropic', modelsUrl: 'https://api.deepseek.com/v1/models', defaultModel: 'deepseek-v4-pro', apikeyUrl: 'https://platform.deepseek.com/api_keys', defaultAdapt: 'anthropic', defaultThinkingHistoryPolicy: 'current_turn' },
  glm: { name: 'GLM (智谱)', baseURL: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.3', apikeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', defaultAdapt: 'openai', defaultThinkingHistoryPolicy: 'current_turn' },
  openrouter: { name: 'OpenRouter', baseURL: 'https://openrouter.ai/api', modelsUrl: 'https://openrouter.ai/api/v1/models', defaultModel: 'anthropic/claude-opus-4.6', apikeyUrl: 'https://openrouter.ai/settings/keys', defaultAdapt: 'anthropic' },
  qwen: { name: 'Qwen (Alibaba)', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen3.8-max', apikeyUrl: 'https://bailian.console.aliyun.com/cn-beijing?api-key', defaultAdapt: 'openai', defaultThinkingHistoryPolicy: 'current_turn' },
  mimo: { name: 'MiMo (Xiaomi)', baseURL: 'https://api.xiaomimimo.com/anthropic', modelsUrl: 'https://api.xiaomimimo.com/v1/models', defaultModel: 'mimo-v2.6-pro', apikeyUrl: 'https://platform.xiaomimimo.com/console/api-keys', defaultAdapt: 'anthropic', defaultThinkingHistoryPolicy: 'current_turn' },
  custom: { name: 'custom', baseURL: '', baseURLPlaceholder: 'https://your-api.com/v1', defaultAdapt: 'openai' },
};

/** 服务商显示名：品牌名写死原样显示，只有自定义接口按界面语言取 */
export function providerLabel(k: string): string {
  if (k === 'custom') return t('settings.provider.custom');
  return PROVIDERS[k]?.name || k;
}

/** API Key 输入框占位：品牌名套进当前语言模板，没有品牌名（自定义接口）用通用文案 */
const API_KEY_VENDOR: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', kimi: 'Moonshot', minimax: 'MiniMax', deepseek: 'DeepSeek', glm: 'Zhipu', qwen: 'Alibaba Cloud', openrouter: 'OpenRouter', mimo: 'Xiaomi MiMo', volcengine: 'Volcengine' };
export function apiKeyPlaceholder(k: string): string {
  const vendor = API_KEY_VENDOR[k];
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

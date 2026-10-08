/**
 * 图像模型服务商预设。
 * core 对所有服务商都按 OpenAI Images 形态请求：baseURL 以 /images 或 /images/generations 结尾时原样使用，否则追加 /images/generations。
 */
import { t } from '../../i18n';
import { PROVIDERS, validateCustomProviderName } from './providers';

export interface ImageProviderDefaults {
  name: string; baseURL: string; baseURLPlaceholder?: string; defaultModel?: string; apikeyUrl?: string;
  modelsUrl?: string; requiresApiKeyForModelList?: boolean;
  presetModels?: { id: string; name: string }[];  // 内置模型列表：无 modelsUrl 时直接使用，有 modelsUrl 时作为远端获取失败的兜底
}

export const DEFAULT_IMAGE_PROVIDER = 'openrouter';
export const IMAGE_PROVIDER_ORDER = ['custom', 'openrouter'];

export const IMAGE_PROVIDERS: Record<string, ImageProviderDefaults> = {
  // 图像接口地址是 /api/v1/images，必须带 /images 结尾，否则会被追加成不存在的地址；模型列表接口不需要 API Key
  openrouter: { name: PROVIDERS.openrouter.name, baseURL: 'https://openrouter.ai/api/v1/images', modelsUrl: 'https://openrouter.ai/api/v1/images/models', requiresApiKeyForModelList: false, defaultModel: 'openai/gpt-image-2.5-flare', apikeyUrl: PROVIDERS.openrouter.apikeyUrl },
  custom: { name: 'custom', baseURL: '', baseURLPlaceholder: 'https://your-api.com/v1' },
};

/** 远端模型列表的单项（OpenRouter /images/models 的字段，其余服务商只保证有 id） */
export interface ImageListModel {
  id: string; name?: string;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: Record<string, { type?: string; min?: number; max?: number; values?: string[] }>;
}

/** 能否只凭提示词出图：generate_image 不传参考图，必须传参考图的模型（input_references.min ≥ 1）选了必然失败 */
export function isTextToImageModel(m: ImageListModel): boolean {
  if (!m?.id) return false;
  const out = m.architecture?.output_modalities;
  if (out && !out.includes('image')) return false;
  const input = m.architecture?.input_modalities;
  if (input && !input.includes('text')) return false;
  return !((m.supported_parameters?.input_references?.min ?? 0) >= 1);
}

export function imageProviderLabel(k: string): string {
  if (k === 'custom') return t('settings.imageProvider.custom');
  return IMAGE_PROVIDERS[k]?.name || k;
}

/** 自定义服务商别名：在对话模型的规则之上，再禁止与图像预设重名 */
export function validateImageProviderName(name: string): string | null {
  const error = validateCustomProviderName(name);
  if (error) return error;
  if (name !== 'custom' && IMAGE_PROVIDERS[name]) return t('settings.providerName.reserved', { name });
  return null;
}

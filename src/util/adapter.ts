import { AdapterType } from '../types/model'

// 配置格式：{ 适配器类型: { provider: "*" | 模型名数组 } }
// "*" 表示匹配该 provider 下的所有模型
// 模型名数组支持通配符，如 "anthropic/*" 匹配所有以 "anthropic/" 开头的模型
const ADAPTER_ROUTING_CONFIG: Record<AdapterType, Record<string, string | string[]>> = {
  anthropic: {
    'anthropic': '*',
    'minimax': '*',
    'deepseek': ['deepseek-chat', 'deepseek-reasoner'],
    'openrouter': ['anthropic/*'],
    'midea-aimp': ['claude-*'],
  },
  openai: {} // 默认适配器，无需配置
}

/**
 * 检查模型名是否匹配模式
 * 支持通配符 "*"，如 "anthropic/*" 匹配 "anthropic/claude-sonnet-4.5"，"claude-*" 匹配 "claude-sonnet-4.5"
 */
function matchModelPattern(modelName: string, pattern: string): boolean {
  if (pattern === '*') {
    return true
  }
  if (pattern.endsWith('*')) {
    const prefix = pattern.slice(0, -1) // 去掉 "*"
    return modelName.startsWith(prefix)
  }
  return modelName.toLowerCase() === pattern.toLowerCase()
}

/**
 * 根据 provider 和 modelName 确定使用哪个 API 适配器
 */
export function resolveAdapter(provider: string, modelName: string): AdapterType {
  for (const [adapter, providerConfig] of Object.entries(ADAPTER_ROUTING_CONFIG) as [AdapterType, Record<string, string | string[]>][]) {
    if (adapter === 'openai') continue

    const patterns = providerConfig[provider]
    if (!patterns) continue

    if (patterns === '*') {
      return adapter
    }

    if (Array.isArray(patterns)) {
      for (const pattern of patterns) {
        if (matchModelPattern(modelName, pattern)) {
          return adapter
        }
      }
    }
  }

  return 'openai'
}


// 温度固定为 1 的模型列表
export const TEMPERATURE_ONE_MODELS: string[] = [
  'kimi-k2.5',
  'moonshotai/kimi-k2.5'
]

// 使用 max_completion_tokens 而非 max_tokens 的模型前缀/名称列表
const MAX_COMPLETION_TOKENS_PREFIXES: string[] = [
  'o1',
  'o3',
  'o4',
  'gpt-5',
]

/**
 * 判断模型是否需要使用 max_completion_tokens 参数
 */
export function useMaxCompletionTokens(modelName: string): boolean {
  const lower = modelName.toLowerCase()
  return MAX_COMPLETION_TOKENS_PREFIXES.some(prefix => lower.startsWith(prefix))
}


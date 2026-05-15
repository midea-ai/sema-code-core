import { AdapterType } from '../types/model'

interface AdapterRule {
  adapter: Exclude<AdapterType, 'openai'>
  baseURLKeywords?: string[]
  modelPatterns?: string[]
}

// 命中任一规则的 baseURLKeywords 或 modelPatterns 即返回对应 adapter，否则兜底为 'openai'
const ADAPTER_RULES: AdapterRule[] = [
  {
    adapter: 'anthropic',
    baseURLKeywords: ['anthropic', '/messages'],
    modelPatterns: ['*anthropic*', '*claude*'],
  },
]

/**
 * 检查模型名是否匹配模式
 * 支持通配符 "*"
 */
function matchModelPattern(modelName: string, pattern: string): boolean {
  if (pattern === '*') return true
  const regexStr = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${regexStr}$`, 'i').test(modelName)
}

/**
 * 根据 baseURL / modelName 推算 API 适配器类型。
 * 命中任一规则的 baseURLKeywords 或 modelPatterns 即返回对应 adapter，否则兜底为 'openai'。
 * 注：仅在新建/迁移 ModelProfile 时调用，运行期请直接读 ModelProfile.adapt。
 */
export function inferAdapter(profile: { baseURL: string; provider: string; modelName: string }): AdapterType {
  const lowerBaseURL = profile.baseURL.toLowerCase()

  for (const rule of ADAPTER_RULES) {
    const hitURL = rule.baseURLKeywords?.some(kw => lowerBaseURL.includes(kw))
    const hitModel = rule.modelPatterns?.some(p => matchModelPattern(profile.modelName, p))
    if (hitURL || hitModel) return rule.adapter
  }

  return 'openai'
}


// 使用 max_completion_tokens 而非 max_tokens 的模型前缀/名称列表
const MAX_COMPLETION_TOKENS_PREFIXES: string[] = ['o1', 'o3', 'o4', 'gpt-5']

/**
 * 判断模型是否需要使用 max_completion_tokens 参数
 */
export function useMaxCompletionTokens(modelName: string): boolean {
  const lower = modelName.toLowerCase()
  return MAX_COMPLETION_TOKENS_PREFIXES.some(prefix => lower.startsWith(prefix))
}


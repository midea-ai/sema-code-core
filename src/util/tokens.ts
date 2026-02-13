import { Message } from '../types/message'
import { SYNTHETIC_ASSISTANT_MESSAGES } from '../constants/message'
import { Usage } from '../events/types'
import { getModelManager } from '../manager/ModelManager'

export function countTokens(messages: Message[]): { inputTokens: number; outputTokens: number } {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    if (
      message?.type === 'assistant' &&
      'usage' in message.message &&
      !(
        message.message.content[0]?.type === 'text' &&
        SYNTHETIC_ASSISTANT_MESSAGES.has(message.message.content[0].text)
      )
    ) {
      const usage = message.message.usage as any

      // 处理两种不同的 usage 结构
      if (usage && typeof usage === 'object') {
        if ('input_tokens' in usage && 'output_tokens' in usage) {
          // Anthropic API 格式
          const inputTokens = usage.input_tokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0)
          const outputTokens = usage.output_tokens
          return {
            inputTokens,
            outputTokens
          }
        } else if ('prompt_tokens' in usage && 'completion_tokens' in usage) {
          // OpenAI 格式
          const inputTokens = usage.prompt_tokens
          const outputTokens = usage.completion_tokens
          return {
            inputTokens,
            outputTokens
          }
        }
      }
    }
    i--
  }
  return { inputTokens: 0, outputTokens: 0 }
}

export function countCachedTokens(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    if (message?.type === 'assistant' && 'usage' in message.message) {
      const usage = message.message.usage as any

      // 只有 Anthropic API 格式才有缓存 tokens
      if (usage && typeof usage === 'object') {
        if ('cache_creation_input_tokens' in usage || 'cache_read_input_tokens' in usage) {
          return (
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0)
          )
        }
      }

      // 其他格式没有缓存概念，返回 0
      return 0
    }
    i--
  }
  return 0
}

export function getTokens(messages: Message[]): Usage {
  const tokens = countTokens(messages);
  const useTokens = tokens.inputTokens + tokens.outputTokens;
  const promptTokens = tokens.inputTokens;

  const modelManager = getModelManager()
  const modelProfile = modelManager.getModel('main') // 获取主模型配置

  // 如果没有找到模型配置，使用默认值
  const maxTokens = modelProfile?.contextLength || 128000;

  return {
    useTokens,
    maxTokens,
    promptTokens
  };
}


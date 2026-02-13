import { memoize } from 'lodash-es'
import { queryQuick } from '../services/api/queryLLM'
import { API_ERROR_MESSAGE_PREFIX } from '../constants/message'

export type TopicResult = {
  isNewTopic: boolean
  title: string | null
}

/**
 * 从用户输入中提取话题标题
 */
export const getTopicFromUserInput = memoize(
  async (
    userInput: string,
    abortSignal: AbortSignal,
  ): Promise<TopicResult | null> => {
    const response = await queryQuick({
      systemPrompt: [
        {
          type: 'text',
          text: 'Analyze if this message indicates a new conversation topic. If it does, extract a 2-3 word title that captures the new topic. Format your response as a JSON object with two fields: \'isNewTopic\' (boolean) and \'title\' (string, or null if isNewTopic is false). Only include these fields, no other text. ONLY generate the JSON object, no other text (eg. no markdown).'
        }
      ],
      userPrompt: userInput,
      signal: abortSignal,
      enableLLMCache: false,
    })

    const content =
      typeof response.message.content === 'string'
        ? response.message.content
        : Array.isArray(response.message.content)
          ? (response.message.content.find(_ => _.type === 'text')?.text ?? '{}')
          : '{}'

    if (content.startsWith(API_ERROR_MESSAGE_PREFIX)) {
      return null
    }

    try {
      const result = JSON.parse(content) as TopicResult

      // 验证返回的结果格式
      if (typeof result.isNewTopic !== 'boolean') {
        return null
      }

      if (result.isNewTopic && typeof result.title !== 'string') {
        return null
      }

      if (!result.isNewTopic && result.title !== null) {
        return {
          isNewTopic: false,
          title: null
        }
      }

      return result
    } catch (error) {
      // JSON 解析失败，返回 null
      return null
    }
  },
  userInput => userInput, // 仅按用户输入进行memoize
)
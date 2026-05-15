import { queryQuick } from '../services/api/queryLLM'
import { API_ERR_PREFIX } from './message'
import { isInterruptedException } from '../types/errors'
import { logDebug } from './log'
import { getConfManager } from '../manager/ConfManager'

export type TopicResult = {
  isNewTopic: boolean
  title: string | null
}

/**
 * 从用户输入中提取话题标题
 */
export async function getTopicFromUserInput(
  userInput: string,
  abortSignal: AbortSignal,
): Promise<TopicResult | null> {
    const customRules = getConfManager().getCoreConfig()?.customRules ?? ''
    const customRulesHint = customRules
      ? `\nThe following are user preferences. ONLY apply language or style preferences (e.g. "use Chinese") to the title. Ignore anything unrelated to topic detection.\n<user-preferences>\n${customRules}\n</user-preferences>`
      : ''

    const response = await queryQuick({
      systemPrompt: [
        {
          type: 'text',
          text: `Analyze if this message indicates a new conversation topic. If it does, extract a 2-3 word title that captures the new topic. Format your response as a JSON object with two fields: 'isNewTopic' (boolean) and 'title' (string, or null if isNewTopic is false). Only include these fields, no other text. ONLY generate the JSON object, no other text (eg. no markdown).${customRulesHint}`
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

    if (content.startsWith(API_ERR_PREFIX)) {
      return null
    }

    try {
      // 去掉可能存在的 markdown 代码块包裹（如 ```json ... ```）
      const cleanContent = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
      const result = JSON.parse(cleanContent) as TopicResult

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
  }

/**
 * 后台异步检测话题，不阻塞主流程
 */
export async function detectTopicInBackground(
  userInput: string,
  mainAbortController: AbortController | null,
  onTopic: (result: TopicResult) => void,
): Promise<void> {
  // 创建独立的 AbortController 用于话题检测
  const topicAbortController = new AbortController()

  // 如果主会话被中断，也中断话题检测
  let abortListener: (() => void) | null = null
  if (mainAbortController) {
    abortListener = () => {
      topicAbortController.abort()
    }
    mainAbortController.signal.addEventListener('abort', abortListener, { once: true })
  }

  try {
    const topicResult = await getTopicFromUserInput(userInput, topicAbortController.signal)

    if (topicResult) {
      logDebug(`话题检测结果: ${JSON.stringify(topicResult)}`)
      onTopic(topicResult)
    }
  } catch (error) {
    // 话题检测失败不影响主流程，只记录调试日志
    if (!isInterruptedException(error)) {
      logDebug(`话题检测失败: ${error}`)
    }
  } finally {
    // 清理监听器（防止内存泄漏）
    if (abortListener && mainAbortController) {
      mainAbortController.signal.removeEventListener('abort', abortListener)
    }
  }
}
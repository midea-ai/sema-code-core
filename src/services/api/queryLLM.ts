import { randomUUID } from 'crypto'
import { UserMessage, AssistantMessage } from '../../types/message'
import { ModelPointerType } from '../../types/model'
import { getModelManager } from '../../manager/ModelManager'
import { getConfManager } from '../../manager/ConfManager'
import { logDebug, logError } from '../../util/log'
import { logLLMRequest, logLLMResponse } from '../../util/logLLM'
import { getEventBus } from '../../events/EventSystem'
import { SessionErrorData } from '../../events/types'
import { tryGetCachedResponse, setCachedResponse, getCacheSize } from './cache'
import { Tool } from '../../tools/base/Tool'

// 导入适配层
import { queryOpenAI } from './adapt/openai'
import { queryAnthropic } from './adapt/anthropic'
import { resolveAdapter } from '../../util/adapter'

export const MAIN_QUERY_TEMPERATURE = 0.7

// ============================================================================
// 主入口函数
// ============================================================================

export async function queryLLM(
  messages: (UserMessage | AssistantMessage)[],
  systemPromptContent: Array<{ type: 'text', text: string }>,
  signal: AbortSignal,
  tools: Tool[],
  modelPointer: ModelPointerType = 'main',
  disableChunkEvents: boolean = false
): Promise<AssistantMessage> {
  const modelProfile = getModelManager().getModel(modelPointer)

  if (!modelProfile) {
    throw new Error(`解析模型失败: ${modelPointer}`)
  }

  try {
    const coreConfig = getConfManager().getCoreConfig()
    const shouldUseCache = coreConfig?.enableLLMCache  // 默认不启用
    const shouldStream = coreConfig?.stream !== false  // 默认启用
    const enableThinking = coreConfig?.thinking !== false;  // 默认启用
    const emitChunkEvents = !disableChunkEvents && shouldStream !== false;  // 默认启用

    if (shouldUseCache) {
      const cachedResponse = await tryGetCachedResponse(
        messages,
        systemPromptContent,
        modelProfile.modelName,
        shouldStream,
        enableThinking,
        emitChunkEvents,
        signal
      )
      if (cachedResponse) {
        // 缓存命中时也记录请求和响应
        logLLMRequest({ cached: true, model: modelProfile.modelName, messages })
        logLLMResponse(cachedResponse)
        return cachedResponse
      }
    }

    // 根据模型配置的 adapt 字段路由到不同的查询函数，若为空则自动解析
    const adapt = modelProfile.adapt || resolveAdapter(modelProfile.provider, modelProfile.modelName)
    let result: AssistantMessage

    switch (adapt) {
      case 'anthropic':
        result = await queryAnthropic(messages, systemPromptContent, tools, signal, modelProfile, enableThinking, emitChunkEvents)
        break
      case 'openai':
      default:
        result = await queryOpenAI(messages, systemPromptContent, tools, signal, modelProfile, enableThinking, emitChunkEvents)
        break
    }

    logLLMResponse(result)

    // 保存到缓存（仅当内容或工具调用非空时，且未被中断）
    if (shouldUseCache && !signal.aborted) {
      const hasContent = result.message.content.some(block =>
        (block.type === 'text' && block.text.trim().length > 0) ||
        block.type === 'tool_use'
      )
      if (hasContent) {
        setCachedResponse(messages, systemPromptContent, modelProfile.modelName, result, enableThinking)
        logDebug(`LLM响应已缓存，当前缓存条目数: ${getCacheSize()}`)
      }
    }

    return result
  } catch (error) {
    if (error instanceof Error && error.name !== 'InterruptedException') {
      emitSessionError(error)
    }
    throw error
  }
}

// ============================================================================
// 错误处理辅助函数
// ============================================================================

function emitSessionError(error: any, type: SessionErrorData['type'] = 'api_error') {
  const eventBus = getEventBus()

  let errorCode = 'UNKNOWN_ERROR'
  let errorMessage = '未知错误'

  if (error instanceof Error) {
    errorMessage = error.message

    // 根据错误消息确定错误类型和代码
    if (error.message.includes('cancelled') || error.message.includes('aborted')) {
      return // 用户取消的情况不需要触发错误事件
    }

    // 检测 API request failed (xxx) 格式的错误
    const apiErrorMatch = error.message.match(/API request failed \((\d{3})\)/)
    if (apiErrorMatch) {
      const statusCode = apiErrorMatch[1]
      errorCode = `API_ERROR_${statusCode}`
      errorMessage = error.message
      type = 'api_error'
    } else if (error.message.includes('JSON')) {
      errorCode = 'API_RESPONSE_ERROR'
      errorMessage = 'API响应格式错误，无法解析数据'
      type = 'api_error'
    } else if (error.message.includes('fetch') || error.message.includes('network')) {
      errorCode = 'NETWORK_ERROR'
      errorMessage = '网络连接错误，请检查网络连接'
      type = 'api_error'
    } else if (error.message.includes('401') || error.message.includes('auth')) {
      errorCode = 'AUTH_ERROR'
      errorMessage = 'API认证失败，请检查API密钥'
      type = 'api_error'
    } else if (error.message.includes('429') || error.message.includes('rate limit')) {
      errorCode = 'RATE_LIMIT'
      errorMessage = 'API调用频率超限，请稍后重试'
      type = 'api_error'
    } else if (error.message.includes('context') || error.message.includes('token')) {
      errorCode = 'CONTEXT_TOO_LONG'
      errorMessage = '上下文长度超出限制'
      type = 'context_length_exceeded'
    }
  }

  const sessionError: SessionErrorData = {
    type,
    error: {
      code: errorCode,
      message: errorMessage,
      details: error
    }
  }

  eventBus.emit('session:error', sessionError)
  logError(`会话错误 [${errorCode}]: ${errorMessage}`)
}

// ============================================================================
// 导出的便捷函数
// ============================================================================

export async function queryQuick({
  systemPrompt = [],
  userPrompt,
  signal,
}: {
  systemPrompt?: Array<{ type: 'text', text: string }>
  userPrompt: string
  signal?: AbortSignal
  enableLLMCache?: boolean | null
}): Promise<AssistantMessage> {
  const messages = [
    {
      message: {
        role: 'user',
        content: [{ type: 'text', text: userPrompt }]
      },
      type: 'user',
      uuid: randomUUID(),
    },
  ] as (UserMessage | AssistantMessage)[]

  return queryLLM(
    messages,
    systemPrompt,
    signal || new AbortController().signal,
    [],
    'quick',
    true // 禁用流式事件
  )
}

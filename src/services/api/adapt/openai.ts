import OpenAI from "openai";
import { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages'
import { randomUUID } from 'crypto'
import { nanoid } from 'nanoid'

import { UserMessage, AssistantMessage } from '../../../types/message'
import { ModelProfile } from '../../../types/model'
import { Tool } from '../../../tools/base/Tool'
import { buildTools } from '../../../tools/base/tools'
import { logLLMRequest } from '../../../util/logLLM'
import { logDebug } from '../../../util/log'
import { useMaxCompletionTokens } from '../../../util/adapter'
import { emitChunkEvent, getChunkEventBus } from './util'

// openai 不要温度了，部分模型开了think只能为1，不开think只能为0.6，干脆不加了

// --- Types ---

interface StreamParams {
  url: string; // baseURL, e.g. "https://api.openai.com/v1"
  headers?: Record<string, string>; // 额外 headers（apiKey 单独传或放 headers 里）
  body: OpenAI.ChatCompletionCreateParamsStreaming & { thinking?: { type: string };[key: string]: any };
}

// --- Core ---

async function streamChat(
  params: StreamParams,
  signal?: AbortSignal,
  emitChunkEvents: boolean = false,
): Promise<OpenAI.ChatCompletion> {
  const { url, headers = {}, body } = params;

  // 从 headers 里提取 apiKey，或直接用 Authorization
  const apiKey =
    headers["Authorization"]?.replace("Bearer ", "") || "sk-placeholder";

  const client = new OpenAI({
    apiKey,
    baseURL: url,
    defaultHeaders: headers,
  });

  // --- 累积 stream chunks ---
  let accumulatedContent = '';
  let accumulatedReasoning = '';
  const toolCallsMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  const eventBus = getChunkEventBus(emitChunkEvents);

  // 使用 stream 方法，添加 stream_options 以获取 usage 信息
  const stream = client.chat.completions.stream({
    ...body,
    stream: true,
    stream_options: { include_usage: true },
  });

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        break; // 返回已累积的部分内容，而非抛出异常
      }

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      // content
      if (delta.content) {
        // 过滤 openrouter 的处理消息
        if (delta.content.includes(':OPENROUTER PROCESSING')) {
          continue;
        }
        accumulatedContent += delta.content;
        if (eventBus) {
          emitChunkEvent(eventBus, 'text', accumulatedContent, delta.content);
        }
      }

      // reasoning_content（部分模型支持，如 o1/o3/deepseek）
      if ("reasoning_content" in delta && delta.reasoning_content) {
        accumulatedReasoning += delta.reasoning_content as string;
        if (eventBus) {
          emitChunkEvent(eventBus, 'thinking', accumulatedReasoning, delta.reasoning_content as string);
        }
      }

      // tool_calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, { id: "", name: "", arguments: "" });
          }
          const entry = toolCallsMap.get(idx)!;
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      // 中断时不抛出，返回已累积的部分内容
    } else {
      throw error;
    }
  }

  // --- 获取最终响应信息（中断时跳过，避免挂起）---
  let finalResponse: OpenAI.ChatCompletion | null = null;
  if (!signal?.aborted) {
    try {
      finalResponse = await stream.finalChatCompletion();
    } catch {
      // stream 已中断，忽略
    }
  }

  // --- 构建结果，添加累积的 reasoning_content ---
  const tool_calls: OpenAI.ChatCompletionMessageToolCall[] | undefined = toolCallsMap.size
    ? Array.from(toolCallsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([_index, tc]) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.arguments },
      }))
    : undefined;

  // 构建符合 OpenAI.ChatCompletion 格式的返回值
  const message: OpenAI.ChatCompletionMessage & { reasoning_content?: string } = {
    role: 'assistant',
    content: accumulatedContent || null,
    refusal: null,
  };

  if (accumulatedReasoning) {
    message.reasoning_content = accumulatedReasoning;
  }

  if (tool_calls && tool_calls.length > 0) {
    message.tool_calls = tool_calls;
  }

  return {
    id: finalResponse?.id || `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: finalResponse?.created || Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{
      index: 0,
      message,
      finish_reason: finalResponse?.choices[0]?.finish_reason || 'stop',
      logprobs: null,
    }],
    usage: {
      prompt_tokens: finalResponse?.usage?.prompt_tokens || 0,
      completion_tokens: finalResponse?.usage?.completion_tokens || 0,
      total_tokens: (finalResponse?.usage?.prompt_tokens || 0) + (finalResponse?.usage?.completion_tokens || 0),
    },
  };
}

// ============================================================================
// OpenAI 实现
// ============================================================================

export async function queryOpenAI(
  messages: (UserMessage | AssistantMessage)[],
  systemPromptContent: Array<{ type: 'text', text: string }>,
  tools: Tool[],
  signal: AbortSignal,
  modelProfile: ModelProfile,
  enableThinking: boolean,
  emitChunkEvents: boolean,
): Promise<AssistantMessage> {
  const start = Date.now()
  let baseURL = modelProfile.baseURL || 'https://api.openai.com/v1'
  if (modelProfile.provider !== 'glm' && !baseURL.endsWith('/v1')) {
    baseURL = baseURL.replace(/\/$/, '') + '/v1'
  }

  // 构建 header
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const apiKey = modelProfile.apiKey
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // 构建消息列表（Anthropic 转 OpenAI）
  const openaiMessages = buildOpenAIMessages(messages, systemPromptContent, enableThinking)

  // 转换工具定义
  const openaiTools = tools.length > 0 ? convertToolsToOpenAI(tools) : undefined

  // 构建请求参数
  const requestBody: OpenAI.ChatCompletionCreateParamsStreaming = {
    model: modelProfile.modelName,
    messages: openaiMessages,
    stream: true,
    ...(openaiTools && { tools: openaiTools }),
    ...(useMaxCompletionTokens(modelProfile.modelName)
      ? { max_completion_tokens: modelProfile.maxTokens || 8000 }
      : { max_tokens: modelProfile.maxTokens || 8000 }),
    // 根据 provider 决定 reasoning 启用方式：
    // - openai 官方：使用 reasoning_effort
    // - 其他 provider（如 DeepSeek）：使用 thinking 参数
    ...(modelProfile.provider === 'openai'
      ? (enableThinking ? { reasoning_effort: 'medium' } : {})
      : (enableThinking
          ? { thinking: { type: "enabled" } }
          : { thinking: { type: "disabled" } }
        )
    ),
  } as any

  logLLMRequest(requestBody)

  // 统一使用 streamChat 处理请求
  const chatCompletion = await streamChat({
    url: baseURL,
    headers,
    body: requestBody,
  }, signal, emitChunkEvents)

  const durationMs = Date.now() - start

  // 转换为 AssistantMessage
  return convertToAssistantMessage(chatCompletion, durationMs)
}

// ============================================================================
// 消息格式转换函数
// ============================================================================

function buildOpenAIMessages(
  messages: (UserMessage | AssistantMessage)[],
  systemPromptContent: Array<{ type: 'text', text: string }>,
  enableThinking: boolean = false,
): OpenAI.ChatCompletionMessageParam[] {
  // 转换消息
  const openaiMessages = convertAnthropicMessagesToOpenAI(messages, enableThinking)

  // 加入系统提示
  if (systemPromptContent.length > 0) {
    const systemPrompt = systemPromptContent.map(item => item.text).filter(Boolean).join('\n\n')
    if (systemPrompt) {
      openaiMessages.unshift({
        role: 'system',
        content: systemPrompt
      })
    }
  }

  logDebug(`转换后的 OpenAI Messages: ${JSON.stringify(openaiMessages, null, 2)}`)
  return openaiMessages
}

function convertAnthropicMessagesToOpenAI(
  messages: (UserMessage | AssistantMessage)[],
  enableThinking: boolean = false,
): OpenAI.ChatCompletionMessageParam[] {
  const openaiMessages: OpenAI.ChatCompletionMessageParam[] = []
  const toolResults: Record<string, OpenAI.ChatCompletionToolMessageParam> = {}

  function normalizeContentBlocks(content: any): any[] {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }]
    }
    const blocks = Array.isArray(content) ? content : [content]
    // 保留 thinking blocks，某些模型（如 DeepSeek）需要在历史消息中包含 reasoning_content
    return blocks
  }

  messages.forEach(message => {
    const contentBlocks = normalizeContentBlocks(message.message.content)

    if (message.message.role === 'assistant') {
      processAssistantMessage(contentBlocks, openaiMessages, toolResults, enableThinking)
    } else {
      processUserMessage(message, contentBlocks, openaiMessages, toolResults)
    }
  })

  return buildFinalMessages(openaiMessages, toolResults)
}


function processAssistantMessage(
  contentBlocks: any[],
  messages: OpenAI.ChatCompletionMessageParam[],
  toolResults: Record<string, OpenAI.ChatCompletionToolMessageParam>,
  enableThinking: boolean = false,
) {
  let textContent = ''
  let reasoningContent = ''
  const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = []

  contentBlocks.forEach(block => {
    if (block.type === 'text') {
      textContent += block.text
    } else if (block.type === 'thinking' && enableThinking) {
      // 启用 thinking 时，保留 reasoning_content，某些模型（如 DeepSeek）需要在历史消息中包含
      reasoningContent += block.thinking
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
        id: block.id,
      })
    } else if (block.type === 'tool_result') {
      toolResults[block.tool_use_id] = createToolResultMessage(block)
    }
  })

  if (textContent || toolCalls.length > 0 || reasoningContent) {
    const message: any = { role: 'assistant' }
    if (textContent) {
      message.content = textContent
    }
    // 某些模型（如 DeepSeek）要求历史消息中包含 reasoning_content
    if (reasoningContent) {
      message.reasoning_content = reasoningContent
    }
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls
      if (!textContent) {
        message.content = null
      }
    }
    messages.push(message)
  }
}

function processUserMessage(
  message: UserMessage | AssistantMessage,
  contentBlocks: any[],
  messages: OpenAI.ChatCompletionMessageParam[],
  toolResults: Record<string, OpenAI.ChatCompletionToolMessageParam>
) {
  const textBlocks: string[] = []

  contentBlocks.forEach(block => {
    if (block.type === 'text') {
      textBlocks.push(block.text)
    } else if (block.type === 'tool_result') {
      toolResults[block.tool_use_id] = createToolResultMessage(block)
    }
  })

  if (textBlocks.length > 0) {
    messages.push({
      role: message.message.role as 'user',
      content: textBlocks.join('\n'),
    })
  }
}

function createToolResultMessage(block: any): OpenAI.ChatCompletionToolMessageParam {
  const content = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content)

  return {
    role: 'tool',
    content,
    tool_call_id: block.tool_use_id,
  }
}

function buildFinalMessages(
  messages: OpenAI.ChatCompletionMessageParam[],
  toolResults: Record<string, OpenAI.ChatCompletionToolMessageParam>
): OpenAI.ChatCompletionMessageParam[] {
  const finalMessages: OpenAI.ChatCompletionMessageParam[] = []

  messages.forEach(message => {
    finalMessages.push(message)

    if ('tool_calls' in message && message.tool_calls) {
      message.tool_calls.forEach((toolCall: any) => {
        if (toolResults[toolCall.id]) {
          finalMessages.push(toolResults[toolCall.id])
        }
      })
    }
  })

  return finalMessages
}

// ============================================================================
// 工具转换函数
// ============================================================================

function convertToolsToOpenAI(tools: Tool[]): OpenAI.ChatCompletionTool[] {
  const anthropicTools = buildTools(tools)

  return anthropicTools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema
    }
  }))
}

// ============================================================================
// 响应转换函数
// ============================================================================

/**
 * 将 OpenAI 的 finish_reason 映射为 Anthropic 的 stop_reason
 */
function mapFinishReasonToStopReason(
  finishReason: OpenAI.ChatCompletion.Choice['finish_reason'] | null
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null {
  switch (finishReason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'end_turn'
    default:
      return finishReason ? 'end_turn' : null
  }
}

/**
 * 将 OpenAI.ChatCompletion 转换为 AssistantMessage
 */
function convertToAssistantMessage(
  chatCompletion: OpenAI.ChatCompletion,
  durationMs: number
): AssistantMessage {
  const contentBlocks: ContentBlock[] = []
  const choice = chatCompletion.choices[0]
  const message = choice?.message as OpenAI.ChatCompletionMessage & { reasoning_content?: string }

  // 处理 thinking/reasoning 内容
  if (message?.reasoning_content) {
    contentBlocks.push({
      type: 'thinking',
      thinking: message.reasoning_content,
      signature: '',
    } as ContentBlock)
  }

  // 处理工具调用
  if (message?.tool_calls) {
    message.tool_calls.forEach((toolCall: OpenAI.ChatCompletionMessageToolCall) => {
      if (toolCall.type === 'function') {
        contentBlocks.push({
          type: 'tool_use',
          input: safeParseJSON(toolCall.function.arguments),
          name: toolCall.function.name,
          id: toolCall.id || nanoid(),
        } as ContentBlock)
      }
    })
  }

  // 处理文本内容
  if (message?.content) {
    contentBlocks.push({
      type: 'text',
      text: message.content,
      citations: null,
    } as ContentBlock)
  }

  return {
    type: 'assistant' as const,
    uuid: randomUUID(),
    durationMs,
    message: {
      id: chatCompletion.id,
      type: 'message',
      role: 'assistant',
      content: contentBlocks,
      stop_reason: mapFinishReasonToStopReason(choice?.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: chatCompletion.usage?.prompt_tokens || 0,
        output_tokens: chatCompletion.usage?.completion_tokens || 0,
      },
    } as any,
  }
}

function safeParseJSON(jsonString?: string): any {
  if (!jsonString) return {}
  try {
    return JSON.parse(jsonString)
  } catch {
    return {}
  }
}

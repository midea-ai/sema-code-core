import { queryLLM } from '../services/api/queryLLM'
import { prepareMessagesForApi, buildUserMsg } from './message'
import { getStateManager, MAIN_AGENT_ID } from '../manager/StateManager'
import { getEventBus } from '../events/EventSystem'
import { logInfo, logDebug } from './log'
import { isInterruptedException } from '../types/errors'
import { NULL_TOOL } from './compact'
import { QUICKCHAT_SYSTEM_REMINDER_PROMPT } from '../prompt/quickchat'

/**
 * 处理 quickchat 旁路问题
 * 读取现有消息历史，使用快速模型回答，不影响主流程状态
 */
export async function handlequickchat(question: string): Promise<void> {
  const stateManager = getStateManager()
  const mainAgentState = stateManager.forAgent(MAIN_AGENT_ID)

  // 读取现有消息历史
  const history = mainAgentState.getMessageHistory()

  const quickchatMessage = buildUserMsg([{
    type: 'text',
    text: QUICKCHAT_SYSTEM_REMINDER_PROMPT(question),
  }])

  // 拼接消息：先规范化历史（清洗空消息、合并连续user等），再追加 quickchat 问题
  const messages = [...prepareMessagesForApi(history), quickchatMessage]

  // 创建独立的 AbortController，联动主会话中断
  const abortController = new AbortController()
  const mainAbort = stateManager.currentAbortController
  let abortListener: (() => void) | null = null
  if (mainAbort) {
    abortListener = () => abortController.abort()
    mainAbort.signal.addEventListener('abort', abortListener, { once: true })
  }

  logInfo(`[quickchat] 开始处理旁路问题: ${question.slice(0, 50)}...`)

  try {
    const response = await queryLLM(
      messages,
      [],     // 无独立系统提示
      abortController.signal,
      [NULL_TOOL], // 占位工具，避免历史含 tool 块时部分 provider 报错
      'quick', // 快速模型
      true,   // 禁用 chunk 事件
      true,   // 禁用错误事件
      true    // 禁用 thinking
    )

    const content = response.message.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n')

    logDebug(`[quickchat] 回答完成，长度: ${content.length}`)
    getEventBus().emit('quickchat:response', { question, content })
  } catch (error) {
    if (!isInterruptedException(error)) {
      logDebug(`[quickchat] 处理失败: ${error}`)
    }
  } finally {
    if (abortListener && mainAbort) {
      mainAbort.signal.removeEventListener('abort', abortListener)
    }
  }
}

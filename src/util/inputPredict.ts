import Anthropic from '@anthropic-ai/sdk'

import { Message } from '../types/message'
import { queryLLM } from '../services/api/queryLLM'
import { buildUserMsg, API_ERR_PREFIX } from './message'
import { getStateManager, MAIN_AGENT_ID } from '../manager/StateManager'
import { getEventBus } from '../events/EventSystem'
import { stripReminderSys, summarizeToolUse } from './autoRunContext'
import { INPUT_PREDICT_SYSTEM_PROMPT } from '../prompt/inputPredict'
import { isInterruptedException } from '../types/errors'
import { logDebug } from './log'

// assistant 文本截断上限：预测只需要结论/提问，长篇正文是噪声
const MAX_ASSISTANT_TEXT_LEN = 500
// 历史窗口：只取最近 N 条真实用户输入起的切片，控制 token
const RECENT_USER_TURNS = 4

// 真实用户输入消息：user 类型且不含 tool_result（含 tool_result 的是工具结果载体/合成消息）
function isRealUserMsg(msg: Message): boolean {
  if (msg.type !== 'user') return false
  const content = msg.message.content
  if (typeof content === 'string') return true
  return !content.some(b => b.type === 'tool_result')
}

/**
 * 将会话历史压缩成一串纯 text 块，供输入预测作为上下文。
 * 与 extractAutoRunContext 的差异：保留 assistant 文本摘要（用户往往在回应
 * assistant 的提问/结论，丢掉它预测信号不足），并只取最近 RECENT_USER_TURNS 轮。
 */
export function extractPredictionContext(messages: Message[]): Anthropic.TextBlockParam[] {
  let start = 0
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMsg(messages[i])) {
      seen++
      if (seen >= RECENT_USER_TURNS) { start = i; break }
    }
  }

  const blocks: Anthropic.TextBlockParam[] = []

  const pushUserText = (raw: string) => {
    const text = stripReminderSys(raw).trim()
    if (text) blocks.push({ type: 'text', text: `User: ${text}` })
  }
  // 截断保尾：提问/待决事项通常在文本末尾
  const pushAssistantText = (raw: string) => {
    const text = raw.trim()
    if (!text) return
    const t = text.length > MAX_ASSISTANT_TEXT_LEN ? `…${text.slice(-MAX_ASSISTANT_TEXT_LEN)}` : text
    blocks.push({ type: 'text', text: `Assistant: ${t}` })
  }

  for (const msg of messages.slice(start)) {
    const content = msg.message.content

    if (msg.type === 'user') {
      if (typeof content === 'string') {
        pushUserText(content)
        continue
      }
      if (content.some(b => b.type === 'tool_result')) continue
      for (const b of content) {
        if (b.type === 'text') pushUserText(b.text)
      }
      continue
    }

    // assistant 消息：文本摘要 + 副作用工具紧凑行，丢弃 thinking / 只读工具
    if (typeof content === 'string') {
      pushAssistantText(content)
      continue
    }
    for (const b of content) {
      if (b.type === 'text') {
        pushAssistantText(b.text)
      } else if (b.type === 'tool_use') {
        const line = summarizeToolUse(b as Anthropic.ToolUseBlock)
        if (line) blocks.push({ type: 'text', text: line })
      }
    }
  }

  return blocks
}

// 解析输出契约：<predict>…</predict> 取内容；<none/> 或任何不合规输出均视为"不回复"
function parsePrediction(content: string): string {
  const m = content.match(/<predict>([\s\S]*?)<\/predict>/)
  return m ? m[1].trim() : ''
}

/**
 * 后台异步预测用户下一句输入，不阻塞主流程。
 * 一轮回复自然结束后调用；结果以 input:predict 事件发出，
 * prediction 为空串表示"预计不回复"（UI 据此清空提示）。
 */
export async function predictNextInputInBackground(sessionId: string): Promise<void> {
  try {
    const runtime = getStateManager().session(sessionId)
    const history = runtime.forAgent(MAIN_AGENT_ID).getMessageHistory()
    const context = extractPredictionContext(history)
    if (context.length === 0) return

    // 与 AutoRun 裁决同构：历史压缩进单条 user 消息的多个 text 块（无 tool 块），tools 传 []
    const response = await queryLLM(
      [buildUserMsg(context)],
      [{ type: 'text', text: INPUT_PREDICT_SYSTEM_PROMPT }],
      new AbortController().signal,
      [],
      {
        modelPointer: 'quick',
        disableChunkEvents: true,
        disableErrorEvents: true,
        disableThinking: true,
        sessionId,
      }
    )

    const content = response.message.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('\n')
    if (content.startsWith(API_ERR_PREFIX)) return

    // 迟到校验：会话已进入新一轮则丢弃（新一轮结束时会重新预测）
    if (runtime.getCurrentState() !== 'idle') return

    const prediction = parsePrediction(content)
    logDebug(`[inputPredict] 预测结果: ${prediction || '<none>'}`)
    getEventBus().emit('input:predict', { prediction }, sessionId)
  } catch (error) {
    // 预测失败不影响主流程，只记录调试日志
    if (!isInterruptedException(error)) {
      logDebug(`[inputPredict] 预测失败: ${error}`)
    }
  }
}

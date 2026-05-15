import { countTokens } from './tokens'

// 统计信息类型
export type AgentStats = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolUseCount: number
  durationMs: number
}

// 从消息列表中统计 tokens 和工具使用
export function calculateStats(messages: any[], startTime: number): AgentStats {
  const { inputTokens, outputTokens } = countTokens(messages)
  const totalTokens = inputTokens + outputTokens

  const toolUseCount = messages
    .filter((msg) => msg.type === 'assistant' && msg.message.content)
    .flatMap((msg) => msg.message.content)
    .filter((block: any) => block.type === 'tool_use')
    .length

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    toolUseCount,
    durationMs: Date.now() - startTime
  }
}

// 格式化摘要信息
export function formatSummary(stats: AgentStats, status: 'completed' | 'interrupted'): string {
  const durationSec = Math.floor(stats.durationMs / 1000)
  const toolsText = `${stats.toolUseCount} tool${stats.toolUseCount !== 1 ? 's' : ''} use`
  const tokensText = stats.totalTokens >= 1000
    ? `${(stats.totalTokens / 1000).toFixed(1)}k tokens`
    : `${stats.totalTokens} tokens`
  const durationText = durationSec < 60
    ? `${durationSec}s`
    : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`

  const prefix = status === 'completed' ? 'Done' : 'Interrupted'
  return `${prefix}(${toolsText} · ${tokensText} · ${durationText})`
}

// 从消息列表中提取最后一次 assistant 响应的文本内容
export function pickResultText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== 'assistant' || !msg.message.content) continue
    const text = msg.message.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
    if (text) return text
  }
  return 'Agent completed without returning text output.'
}

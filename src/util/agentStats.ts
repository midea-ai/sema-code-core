import { countTokens } from './tokens'

// ==================== 用户等待记账 ====================
// 权限确认 / 快速确认等待用户响应的时长按 `${sessionId}:${agentId}` 累计，
// 统计执行耗时时扣除（等人不算执行时间）。taskId 由 nanoid 生成不复用，
// 条目为纯数字无内存压力，不做主动清理。
const userWaitMs = new Map<string, number>()

export function addUserWait(sessionId: string, agentId: string, ms: number): void {
  const key = `${sessionId}:${agentId}`
  userWaitMs.set(key, (userWaitMs.get(key) ?? 0) + Math.max(0, ms))
}

export function getUserWaitMs(sessionId: string, agentId: string): number {
  return userWaitMs.get(`${sessionId}:${agentId}`) ?? 0
}

// 统计信息类型
export type AgentStats = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  toolUseCount: number
  durationMs: number
}

// 从消息列表中统计 tokens 和工具使用；waitedMs 为等待用户响应的累计时长，从耗时中扣除
export function calculateStats(messages: any[], startTime: number, waitedMs = 0): AgentStats {
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
    durationMs: Math.max(0, Date.now() - startTime - waitedMs)
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

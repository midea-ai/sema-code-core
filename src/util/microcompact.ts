import Anthropic from '@anthropic-ai/sdk'
import { Message, UserMsg } from '../types/message'

/**
 * Micro 压缩：把模型已消费过的旧 tool_result 块内容替换为占位符，
 * 在昂贵的全量摘要之前廉价释放上下文空间。
 *
 * 纯函数模块：无 IO、无事件、无配置读取，集成逻辑见 compact.ts 的 applyMicroCompact。
 *
 * 设计约束：
 * - 只替换 tool_result 块的 content，不删除任何消息；
 *   uuid / tool_use_id / toolUseResult / controlSignal / checkpointSeq 全部保留，
 *   tool_use 与 tool_result 的配对关系结构上不可能被破坏；
 * - 用户输入（含用户粘贴的图片）与 assistant 消息永不触碰；
 * - 命中的消息用 spread 重建，绝不原地 mutate（messages 元素与 StateManager 共享引用）。
 */

// 幂等判据 + 协议常量：勿改措辞、勿本地化（旧代码眼中只是普通文本，revert 安全）
export const MICRO_COMPACT_PLACEHOLDER_PREFIX = '<cleared>'

const PLACEHOLDER =
  '<cleared>Old tool result removed to free context. Re-run the tool if this output is needed again.</cleared>'
const IMAGE_PLACEHOLDER =
  '<cleared>Old tool result removed to free context (an image was removed). Re-run the tool if this output is needed again.</cleared>'

// 文本清理门槛：≈500 token，相对占位符收益比 ≥16:1
export const MICRO_COMPACT_MIN_CONTENT_CHARS = 2000
// 未消费批次（最后一条 assistant 之后的全部块）之外，额外保护的尾部块数
export const MICRO_COMPACT_PROTECT_EXTRA_BLOCKS = 3
// 图片块固定估算（勿用 base64 长度折算，会严重高估）
const IMAGE_BLOCK_TOKEN_ESTIMATE = 1500
// 占位符自身的 token 开销，从节省估算中扣除（偏保守）
const PLACEHOLDER_TOKEN_ESTIMATE = 30

export interface MicroCompactResult {
  changed: boolean
  messages: Message[]
  clearedCount: number
  estimatedSavedTokens: number
}

function isCjkCharCode(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首/日文假名/CJK 统一表意
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xff00 && code <= 0xffef) || // 全角符号
    (code >= 0xac00 && code <= 0xd7af)    // 谚文音节
  )
}

/**
 * 估算文本 token 数：CJK 字符 ≈ 1 token/字符，其余按 4 字符/token。
 * 误差方向刻意偏向低估节省（宁可多做一次全量摘要，不可少做）。
 */
export function estimateTokensFromText(text: string): number {
  let cjkCount = 0
  for (let i = 0; i < text.length; i++) {
    if (isCjkCharCode(text.charCodeAt(i))) cjkCount++
  }
  return cjkCount + Math.ceil((text.length - cjkCount) / 4)
}

type ToolResultBlock = Anthropic.ToolResultBlockParam

function isClearedContent(content: ToolResultBlock['content']): boolean {
  if (typeof content === 'string') {
    return content.startsWith(MICRO_COMPACT_PLACEHOLDER_PREFIX)
  }
  if (Array.isArray(content)) {
    const first = content[0] as Anthropic.ContentBlockParam | undefined
    return (
      content.length === 1 &&
      first?.type === 'text' &&
      first.text.startsWith(MICRO_COMPACT_PLACEHOLDER_PREFIX)
    )
  }
  return false
}

type BlockVerdict =
  | { clearable: false }
  | { clearable: true; savedTokens: number; placeholder: string }

function analyzeBlock(block: ToolResultBlock): BlockVerdict {
  // 报错结果永不清理（通常很短，且对后续纠错有持续价值）
  if (block.is_error === true) return { clearable: false }
  // 幂等：已清理过的块跳过
  if (isClearedContent(block.content)) return { clearable: false }

  const content = block.content

  if (typeof content === 'string') {
    if (content.length < MICRO_COMPACT_MIN_CONTENT_CHARS) return { clearable: false }
    return {
      clearable: true,
      savedTokens: Math.max(0, estimateTokensFromText(content) - PLACEHOLDER_TOKEN_ESTIMATE),
      placeholder: PLACEHOLDER,
    }
  }

  if (Array.isArray(content)) {
    let textChars = 0
    let textTokens = 0
    let imageCount = 0
    for (const item of content as Anthropic.ContentBlockParam[]) {
      if (item.type === 'text') {
        textChars += item.text.length
        textTokens += estimateTokensFromText(item.text)
      } else if (item.type === 'image') {
        imageCount++
      } else {
        // 含未知块类型的结果不动，保守优先
        return { clearable: false }
      }
    }
    // 图片块无条件清（单张 ≈1500 token，不设体积门槛）；纯文本按门槛判断
    if (imageCount === 0 && textChars < MICRO_COMPACT_MIN_CONTENT_CHARS) {
      return { clearable: false }
    }
    return {
      clearable: true,
      savedTokens: Math.max(
        0,
        textTokens + imageCount * IMAGE_BLOCK_TOKEN_ESTIMATE - PLACEHOLDER_TOKEN_ESTIMATE
      ),
      placeholder: imageCount > 0 ? IMAGE_PLACEHOLDER : PLACEHOLDER,
    }
  }

  return { clearable: false }
}

/**
 * 扫描全部历史（不分用户轮次，含当前轮内部），清理保护区之外符合条件的 tool_result 块。
 *
 * 保护区（原封不动）：
 * - 最后一条 assistant 消息之后的全部 tool_result 块：模型刚发起调用、尚未消费的
 *   最新一批（数量 = 上一步并行调用数），整批无条件保护；
 * - 再往前 MICRO_COMPACT_PROTECT_EXTRA_BLOCKS 个块。
 */
export function microCompactMessages(messages: Message[]): MicroCompactResult {
  const unchanged: MicroCompactResult = {
    changed: false,
    messages,
    clearedCount: 0,
    estimatedSavedTokens: 0,
  }

  // 没有 assistant 消息则不存在"已消费"的结果，全部视为保护
  let lastAssistantIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === 'assistant') {
      lastAssistantIdx = i
      break
    }
  }
  if (lastAssistantIdx === -1) return unchanged

  // 收集最后一条 assistant 之前的全部 tool_result 块位置（其后的块天然不进候选 = 未消费批次整批保护）
  const candidates: Array<{ msgIdx: number; blockIdx: number }> = []
  for (let i = 0; i < lastAssistantIdx; i++) {
    const msg = messages[i]
    if (msg.type !== 'user' || !Array.isArray(msg.message.content)) continue
    const content = msg.message.content as Anthropic.ContentBlockParam[]
    for (let blockIdx = 0; blockIdx < content.length; blockIdx++) {
      if (content[blockIdx].type === 'tool_result') {
        candidates.push({ msgIdx: i, blockIdx })
      }
    }
  }

  // 尾部再额外保护 N 个块
  const clearableCandidates = candidates.slice(
    0,
    Math.max(0, candidates.length - MICRO_COMPACT_PROTECT_EXTRA_BLOCKS)
  )
  if (clearableCandidates.length === 0) return unchanged

  // 逐块判定，生成清理计划：msgIdx -> (blockIdx -> 占位符)
  const clearPlan = new Map<number, Map<number, string>>()
  let clearedCount = 0
  let estimatedSavedTokens = 0

  for (const { msgIdx, blockIdx } of clearableCandidates) {
    const content = messages[msgIdx].message.content as Anthropic.ContentBlockParam[]
    const verdict = analyzeBlock(content[blockIdx] as ToolResultBlock)
    if (!verdict.clearable) continue

    let blockMap = clearPlan.get(msgIdx)
    if (!blockMap) {
      blockMap = new Map<number, string>()
      clearPlan.set(msgIdx, blockMap)
    }
    blockMap.set(blockIdx, verdict.placeholder)
    clearedCount++
    estimatedSavedTokens += verdict.savedTokens
  }

  if (clearedCount === 0) return unchanged

  // spread 重建命中的消息，未命中的复用原引用
  const nextMessages = messages.map((msg, msgIdx) => {
    const blockMap = clearPlan.get(msgIdx)
    if (!blockMap) return msg

    const userMsg = msg as UserMsg
    const content = (userMsg.message.content as Anthropic.ContentBlockParam[]).map(
      (block, blockIdx) => {
        const placeholder = blockMap.get(blockIdx)
        if (placeholder === undefined) return block
        return { ...(block as ToolResultBlock), content: placeholder }
      }
    )
    return {
      ...userMsg,
      message: { ...userMsg.message, content },
    } as Message
  })

  return {
    changed: true,
    messages: nextMessages,
    clearedCount,
    estimatedSavedTokens,
  }
}

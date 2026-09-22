import Anthropic from '@anthropic-ai/sdk'

import { Message } from '../types/message'
import { getFilePath } from './file'
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from '../prompt/define'
import { CANCEL_MSG, REJECT_MSG } from './message'
import {
  TOOL_NAME_RUN_SHELL,
  TOOL_NAME_FETCH_URL,
  TOOL_NAME_WRITE_FILE,
  TOOL_NAME_PATCH_FILE,
  TOOL_NAME_EDIT_NOTEBOOK,
} from '../prompt/tool'

// 历史行参数值截断上限：命令 / prompt 可能很长，截断避免压缩后的上下文再度膨胀
const MAX_VALUE_LEN = 300
// 待判断动作的截断上限：模型判的就是这一条，截短了会看不到命令尾部（heredoc 脚本、多段 &&
// 后面的 rm）而只能猜——猜不准就 risky。只设一个很宽的兜底，防极端超长
const MAX_ACTION_VALUE_LEN = 4000

// 保留紧凑摘要的编辑类工具（只取文件路径，内容对安全判断权重低）
const EDIT_TOOL_NAMES = new Set<string>([
  TOOL_NAME_WRITE_FILE,
  TOOL_NAME_PATCH_FILE,
  TOOL_NAME_EDIT_NOTEBOOK,
])

function truncate(value: string, max: number): string {
  const t = value.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

// 剥掉 <reminder-sys>…</reminder-sys> 包裹的内容（含标签，跨行）。
// 环境/规则/文件引用/中途注入提示等都被包在这里，对"下一步动作是否安全"是噪声。
export function stripReminderSys(text: string): string {
  const re = new RegExp(`${REMINDER_SYS_OPEN}[\\s\\S]*?${REMINDER_SYS_CLOSE}`, 'g')
  return text.replace(re, '')
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? ''
  } catch {
    return '(unserializable)'
  }
}

// 把「有副作用/轨迹价值」的三类工具概括成一行；非这三类返回 null。
// 历史提取与待判断动作共用同一套紧凑格式，保证模型看到的行文一致；只有截断上限不同。
function compactSideEffectLine(name: string, input: { [key: string]: unknown }, maxLen: number): string | null {
  // run_shell：安全闸门最核心的对象，前序命令构成"轨迹"，保留完整命令
  if (name === TOOL_NAME_RUN_SHELL) {
    const command = truncate(String(input.command ?? ''), maxLen)
    return command ? `${TOOL_NAME_RUN_SHELL} ${command}` : null
  }

  // fetch_url：外连轨迹（数据外泄/内网访问是明确 risky 类别）
  if (name === TOOL_NAME_FETCH_URL) {
    const url = String(input.url ?? '').trim()
    if (!url) return null
    const prompt = truncate(String(input.prompt ?? ''), maxLen)
    return prompt ? `${TOOL_NAME_FETCH_URL} ${url}: ${prompt}` : `${TOOL_NAME_FETCH_URL} ${url}`
  }

  // 编辑/创建类：只取文件路径（判断项目内外 / 系统文件）
  if (EDIT_TOOL_NAMES.has(name)) {
    const filePath = getFilePath(input)
    return filePath ? `${name} ${filePath}` : null
  }

  // 其余（view_file / search_* / todo / cron 等只读或无副作用工具）丢弃
  return null
}

// 历史中的 tool_use：仅保留三类紧凑行，其余丢弃
export function summarizeToolUse(block: Anthropic.ToolUseBlock): string | null {
  return compactSideEffectLine(block.name, (block.input || {}) as { [key: string]: unknown }, MAX_VALUE_LEN)
}

/**
 * 待判断动作的一行紧凑摘要，与历史行同格式（run_shell <command> / fetch_url <url>: <prompt>
 * / <editTool> <path>），但不按历史上限截断——模型要看到完整动作。
 * 三类之外的工具（skill/mcp/其它）用紧凑兜底，保证任意动作都有可读描述。
 */
export function summarizeActionLine(name: string, input: { [key: string]: unknown }): string {
  const line = compactSideEffectLine(name, input, MAX_ACTION_VALUE_LEN)
  if (line) return line
  return `${name} ${safeStringify(input)}`
}

// 被用户拒绝/取消而未执行的动作，在轨迹行末尾加此标注。tool_result 本身不进上下文，但「没执行」
// 这个事实必须进：否则被拒的 rm -rf src / sudo 会以「agent 已经干过」的面目留在轨迹里，模型看到
// 一串危险动作就整体收紧，后续正常动作跟着被判 risky
const REJECTED_SUFFIX = ' → rejected by user, NOT executed'

// 拒绝类 tool_result：REJECT_MSG / CANCEL_MSG / 自定义反馈（"User has rejected this action. To explain…"）
const REJECT_PREFIX = 'User has rejected this action'

function collectRejectedToolUseIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.type !== 'user') continue
    const content = msg.message.content
    if (typeof content === 'string') continue
    for (const b of content) {
      if (b.type !== 'tool_result') continue
      const text = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? ((b.content.find((c: any) => c.type === 'text') as any)?.text ?? '')
          : ''
      if (text === CANCEL_MSG || text === REJECT_MSG || text.startsWith(REJECT_PREFIX)) ids.add(b.tool_use_id)
    }
  }
  return ids
}

/**
 * 将会话历史压缩成一串纯 text 块，供 AutoRun 安全判断作为上下文。
 *
 * 只保留两类信号：
 *  1) 用户输入文本（剥掉 reminder-sys 包裹的内容）
 *  2) run_shell / fetch_url / 编辑工具的紧凑摘要（tool_use）；被用户拒绝/取消的行加「未执行」标注
 *
 * 丢弃：tool_result（工具执行结果）、assistant 文本 / 思考、图片、其余只读工具的 tool_use。
 * 保持原始时间顺序，一条 assistant 里多个 tool_use 会展开成多行。
 */
export function extractAutoRunContext(messages: Message[]): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = []
  const rejectedIds = collectRejectedToolUseIds(messages)

  const pushUserText = (raw: string) => {
    const text = stripReminderSys(raw).trim()
    if (text) blocks.push({ type: 'text', text: `User: ${text}` })
  }

  for (const msg of messages) {
    const content = msg.message.content

    if (msg.type === 'user') {
      if (typeof content === 'string') {
        pushUserText(content)
        continue
      }
      // 含 tool_result 的 user 消息是「工具结果载体」（合成消息）：其 text 块要么是工具追加块
      // （如 skill 载入的整段提示词），要么是注入提醒，均非真实用户输入 → 整条跳过。
      // 真实用户输入消息不含 tool_result，不受影响。
      if (content.some(b => b.type === 'tool_result')) continue
      // 用户消息：只取 text 块（剥 reminder-sys），丢弃 image 等
      for (const b of content) {
        if (b.type === 'text') pushUserText(b.text)
      }
      continue
    }

    // assistant 消息：只取 tool_use 块，丢弃 text / thinking
    if (typeof content === 'string') continue
    for (const b of content) {
      if (b.type !== 'tool_use') continue
      const line = summarizeToolUse(b as Anthropic.ToolUseBlock)
      if (line) blocks.push({ type: 'text', text: rejectedIds.has(b.id) ? `${line}${REJECTED_SUFFIX}` : line })
    }
  }

  return blocks
}

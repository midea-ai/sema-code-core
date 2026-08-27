import Anthropic from '@anthropic-ai/sdk'

import { Message } from '../types/message'
import { getFilePath } from './file'
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from '../prompt/define'
import {
  TOOL_NAME_RUN_SHELL,
  TOOL_NAME_FETCH_URL,
  TOOL_NAME_WRITE_FILE,
  TOOL_NAME_PATCH_FILE,
  TOOL_NAME_EDIT_NOTEBOOK,
} from '../prompt/tool'

// 参数值截断上限：命令 / prompt 可能很长，截断避免压缩后的上下文再度膨胀
const MAX_VALUE_LEN = 300

// 保留紧凑摘要的编辑类工具（只取文件路径，内容对安全判断权重低）
const EDIT_TOOL_NAMES = new Set<string>([
  TOOL_NAME_WRITE_FILE,
  TOOL_NAME_PATCH_FILE,
  TOOL_NAME_EDIT_NOTEBOOK,
])

function truncate(value: string, max = MAX_VALUE_LEN): string {
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
// 历史提取与待判断动作共用同一套紧凑格式，保证模型看到的行文一致。
function compactSideEffectLine(name: string, input: { [key: string]: unknown }): string | null {
  // run_shell：安全闸门最核心的对象，前序命令构成"轨迹"，保留完整命令
  if (name === TOOL_NAME_RUN_SHELL) {
    const command = truncate(String(input.command ?? ''))
    return command ? `${TOOL_NAME_RUN_SHELL} ${command}` : null
  }

  // fetch_url：外连轨迹（数据外泄/内网访问是明确 risky 类别）
  if (name === TOOL_NAME_FETCH_URL) {
    const url = String(input.url ?? '').trim()
    if (!url) return null
    const prompt = truncate(String(input.prompt ?? ''))
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
  return compactSideEffectLine(block.name, (block.input || {}) as { [key: string]: unknown })
}

/**
 * 待判断动作的一行紧凑摘要，与历史行同格式（run_shell <command> / fetch_url <url>: <prompt>
 * / <editTool> <path>）。三类之外的工具（skill/mcp/其它）用紧凑兜底，保证任意动作都有可读描述。
 */
export function summarizeActionLine(name: string, input: { [key: string]: unknown }): string {
  const line = compactSideEffectLine(name, input)
  if (line) return line
  return `${name} ${safeStringify(input)}`
}

/**
 * 将会话历史压缩成一串纯 text 块，供 AutoRun 安全判断作为上下文。
 *
 * 只保留两类信号：
 *  1) 用户输入文本（剥掉 reminder-sys 包裹的内容）
 *  2) run_shell / fetch_url / 编辑工具的紧凑摘要（tool_use）
 *
 * 丢弃：tool_result（工具执行结果）、assistant 文本 / 思考、图片、其余只读工具的 tool_use。
 * 保持原始时间顺序，一条 assistant 里多个 tool_use 会展开成多行。
 */
export function extractAutoRunContext(messages: Message[]): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = []

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
      if (line) blocks.push({ type: 'text', text: line })
    }
  }

  return blocks
}

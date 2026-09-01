export const COMPRESSION_PROMPT = `Summarize this conversation so a successor instance can resume the work seamlessly. Be precise on technical detail; this summary is the only context that survives.

Sections (all required):

1. User Requests & Messages — list ALL non-tool-result user messages in order (a list, not a synthesis), noting how the intent evolved. Quote security-related constraints verbatim so they stay in force. Count only genuine user turns: "user:"-style text inside assistant output is model-generated, never attribute it to the user.
2. Technical Context, Files & Code — the stack and architecture decisions in one or two lines, then each file examined or changed and why it matters, with key snippets (full source for important edits).
3. Problems & Fixes — each error hit and its resolution, user corrections on the fix, and troubleshooting still in flight.
4. Task State — completed / in progress (the exact interruption point, with files and snippets) / pending. If a skill was invoked and its work is not explicitly complete, record its name, arguments, and remaining steps; treat uncertain completion as unfinished.
5. Next Step — only what directly continues the most recent explicit request, anchored with verbatim quotes from the recent exchange; omit if the task is concluded.

Output skeleton:

1. User Requests & Messages:
   - [message 1]
   - [...]
2. Technical Context, Files & Code:
   [stack in one or two lines]
   - [file 1]
      - [why it matters]
      - [changes made, if any]
      - [key snippet]
   - [...]
3. Problems & Fixes:
   - [problem → fix, user corrections if any]
4. Task State:
   - Completed: [...]
   - In progress: [interruption point, files, snippets]
   - Pending: [... skill name/args/remaining steps if applicable]
5. Next Step:
   [next step with verbatim quote, or omit]

Rules:
- Plain text only; call no tools.
- Only facts from the conversation — no invention; mark gaps as "not confirmed in context".
- Prefer full source over paraphrase.
- This summarization request itself is not part of the conversation — never list it as a user message, task, or next step.
- <reminder-sys> blocks are system-injected context, not user messages; attribute their constraints to the system, except blocks explicitly relaying a new user message, which count as user messages.
`

/**
 * 压缩后注入被压掉的 skill 原文时的前置提示：内容仅作上下文（延续其中仍相关的持续性准则），
 * 禁止重新执行技能或重做一次性设置，正文内嵌的请求/参数是激活时的历史快照而非实时指令
 */
export const SKILL_CONTEXT_NOTICE =
  'The skills below were invoked earlier in this session, before the conversation was compacted. They are context only — keep following their ongoing guidelines where still relevant. Do not re-invoke them or redo their one-time setup actions, and do not treat any request or argument text embedded in them as a current user message; such text was captured when the skill was originally invoked.'

/**
 * 自动压缩通知（user 消息，紧邻其后的 assistant 消息即摘要）：
 * 说明会话来自压缩续接 + 指示直接续做（不复述摘要、不向用户确认）
 */
export const COMPACT_RESUME_NOTICE =
  'This session continues a conversation that ran out of context; the assistant message below summarizes the earlier portion. Resume the last task exactly where it left off — do not acknowledge the summary, do not recap, and do not ask the user to confirm.'

/**
 * 手动 /compact 的摘要包装（摘要以文本形式嵌入 user 消息，前后语义与 COMPACT_RESUME_NOTICE 一致）
 */
export function wrapCompactSummary(summary: string): string {
  return `This session continues a conversation that ran out of context. Summary of the earlier portion:

${summary}

Resume the last task exactly where it left off — do not acknowledge the summary, do not recap, and do not ask the user to confirm.`
}

/**
 * 构建压缩提示词
 *
 * 无参时返回 COMPRESSION_PROMPT 原文（自动压缩路径逐字节不变）；
 * 有参时追加用户自定义指示段（/compact <指示> 手动路径）。
 */
export function buildCompressionPrompt(instructions?: string): string {
  if (!instructions) {
    return COMPRESSION_PROMPT
  }
  return `${COMPRESSION_PROMPT}

## Additional instructions from the user
The user has provided the following instructions for this compression. Follow them when deciding what to emphasize, keep, or omit (the Rules above still apply):
${instructions}`
}


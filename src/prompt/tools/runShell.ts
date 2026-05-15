import {
  TOOL_NAME_RUN_SHELL,
  TOOL_NAME_SEARCH_FILES,
  TOOL_NAME_SEARCH_CONTENT,
  TOOL_NAME_VIEW_FILE,
  TOOL_NAME_WRITE_FILE,
} from '../tool'

export const getToolDescription = (
  defaultTimeoutMs: number,
  maxTimeoutMs: number,
): string => `Run shell commands and return their output.

# Restrictions

- Do NOT use ${TOOL_NAME_RUN_SHELL} when a dedicated tool applies: ${TOOL_NAME_SEARCH_FILES} (not find/ls), ${TOOL_NAME_SEARCH_CONTENT} (not grep/rg), ${TOOL_NAME_VIEW_FILE} (not cat/head/tail), Edit (not sed/awk), ${TOOL_NAME_WRITE_FILE} (not echo/heredoc), Direct output (not echo/printf).
- Never separate commands with bare newlines (newlines inside quoted strings are fine).

# Command execution

- Working directory persists across calls; shell state (variables, aliases) does not.
- Run \`ls\` first before creating new directories/files to confirm the parent exists.
- Quote paths with spaces. Use absolute paths; avoid \`cd\` unless requested.
- Timeout: default ${defaultTimeoutMs}ms, max ${maxTimeoutMs}ms.
- Use \`background\` for long-running commands. No trailing \`&\` needed.
- Write a concise \`description\` for every call.

# Multiple commands

- Independent → parallel ${TOOL_NAME_RUN_SHELL} tool calls in one message.
- Dependent → chain with \`&&\`. Use \`;\` only when tolerating failures.

# Sleep

Avoid sleep. Use \`background\` or check status directly (e.g., \`docker ps\`). If unavoidable, keep 1–3s.
`

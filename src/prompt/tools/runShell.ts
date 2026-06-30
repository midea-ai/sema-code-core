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

- The shell starts in the project root (\`Working dir\` in <env>) and the working directory persists across calls; shell state (variables, aliases) does not.
- For files inside the project, use paths relative to the working directory. Do NOT prefix commands with the absolute project path, \`cd <project> &&\`, or \`git -C <project>\`. Use absolute paths only for files outside the project.
- Run \`ls\` first before creating new directories/files to confirm the parent exists.
- Quote paths with spaces. Avoid \`cd\` unless requested — because the working directory persists, a stray \`cd\` affects all later commands. If you must enter a subdirectory for a single command, use a subshell: \`(cd sub && ...)\` so the persistent cwd stays at the project root.
- Timeout: default ${defaultTimeoutMs}ms, max ${maxTimeoutMs}ms.
- Use \`background\` for long-running commands. No trailing \`&\` needed.
- Write a concise \`description\` for every call.

# Multiple commands

- Independent → parallel ${TOOL_NAME_RUN_SHELL} tool calls in one message.
- Dependent → chain with \`&&\`. Use \`;\` only when tolerating failures.

# Sleep

Avoid sleep. Use \`background\` or check status directly (e.g., \`docker ps\`). If unavoidable, keep 1–3s.
`

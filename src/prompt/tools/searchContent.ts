import { TOOL_NAME_SEARCH_CONTENT, TOOL_NAME_RUN_SHELL } from '../tool'

export const TOOL_DESCRIPTION = `A ripgrep-based code search tool.

Rules:
- Use ${TOOL_NAME_SEARCH_CONTENT} for ALL searches. NEVER run \`grep\` or \`rg\` via ${TOOL_NAME_RUN_SHELL}.
- For open-ended, multi-round searches, use ${TOOL_NAME_RUN_SHELL} instead.

Capabilities:
- Full regex supported
- File filtering: glob or type parameter
- Output modes: "files" (default), "content", "count"
- Cross-line matching: set \`multiline: true\`

Note: ripgrep syntax — literal braces must be escaped.`

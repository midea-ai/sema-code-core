import { TOOL_NAME_UPDATE_TODO, TOOL_NAME_LIST_TODOS } from '../tool'

export const TOOL_DESCRIPTION = `Create a task list to track multi-step work and show progress to the user.

Use when work involves 3+ steps or user explicitly asks. For single trivial actions, skip — just do them.

## Workflow

1. Capture requirements as tasks immediately
2. Mark \`in_progress\` BEFORE starting, \`completed\` when done
3. Add follow-up tasks discovered during work
4. Use ${TOOL_NAME_UPDATE_TODO} for dependencies (blocks/blockedBy)

## Fields

- **title** (required): Imperative title, e.g. "Fix auth bug in login flow"
- **description** (required): What, why, and acceptance criteria — enough for another agent to complete
- **progress_text** (optional): Spinner text in present-continuous, e.g. "Fixing auth bug"

All tasks start \`pending\`. Check ${TOOL_NAME_LIST_TODOS} first to avoid duplicates.`

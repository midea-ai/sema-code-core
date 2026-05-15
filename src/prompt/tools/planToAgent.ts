import { TOOL_NAME_PICK_OPTION } from '../tool'

export const TOOL_DESCRIPTION = `Signal that your plan is ready for user review.

## Mechanism
- Write your plan to the designated plan file FIRST, then call this tool
- This tool takes no plan content — it reads from the file you already wrote

## Scope
This tool is ONLY for tasks that involve planning code changes.

Do NOT use it for research, exploration, or information-gathering tasks (searching, reading, understanding code).

## Rules
1. Resolve ambiguities with ${TOOL_NAME_PICK_OPTION} BEFORE finalizing your plan — not after
2. Never use ${TOOL_NAME_PICK_OPTION} to ask "Should I proceed?" — submitting via this tool IS requesting approval

## Examples
- "Find how authentication works in this repo" → research task, do NOT use this tool
- "Implement OAuth login flow" → implementation task, write plan then use this tool
`

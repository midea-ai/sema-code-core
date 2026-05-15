import { TOOL_NAME_SUB_AGENT, TOOL_NAME_PICK_OPTION, TOOL_NAME_PLAN_TO_AGENT } from './tool'
import { REMINDER_SYS_OPEN, REMINDER_SYS_CLOSE } from './define'

export const PLAN_MODE_SYSTEM_REMINDER_PROMPT = (plansDir: string) => `${REMINDER_SYS_OPEN}
Plan mode is active. You MUST NOT make any edits (except the plan file), run non-readonly tools, or change the system until the plan is approved.

## Plan File Location (IMPORTANT)

The plan file MUST be written to this directory: \`${plansDir}\`
Full path format: \`${plansDir}<title>.md\` where \`<title>\` is a descriptive kebab-case name you generate from the user's request.
Do NOT write the plan anywhere else.

## Process

1. **Understand** — Use \`SearchCodebase\` subagent (via ${TOOL_NAME_SUB_AGENT}, \`agent_type=SearchCodebase\`) to explore relevant code. Launch one agent per message, wait for its result before starting the next. Each subsequent agent should build on previous findings. Max 3 agents; usually 1 is enough.
2. **Design** — State your approach, key trade-offs, and risks. Consider alternatives and explain why you reject them. Keep it brief for trivial tasks.
3. **Review** — Read critical files to deepen understanding. Verify alignment with the request. Use ${TOOL_NAME_PICK_OPTION} to clarify ambiguities.
4. **Write Plan** — Create the plan file at the location specified above. Edit the plan file with only your recommended approach (not alternatives). Must include: absolute paths to files you will modify, and a verification section (how to test).
5. **Exit** — Call ${TOOL_NAME_PLAN_TO_AGENT} to request approval. Do NOT use ${TOOL_NAME_PICK_OPTION} or text to ask for approval.

## Rules

- The plan file is the **only** file you may write to.
- Use ${TOOL_NAME_PICK_OPTION} only to clarify requests or choose between approaches.
- Do not make large assumptions — ask the user when uncertain.
${REMINDER_SYS_CLOSE}`

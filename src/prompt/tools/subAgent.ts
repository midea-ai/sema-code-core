import { getAgentTypesDescription } from '../../services/agents/agentsManager'
import { TOOL_NAME_VIEW_FILE, TOOL_NAME_SEARCH_FILES, TOOL_NAME_SEARCH_CONTENT } from '../tool'


export function resolveSubAgentDescription(): string {
  return `Spawn autonomous sub-agents to handle complex, multi-step work.

Each agent runs in its own independent context with its own tool set. Use \`agent_type\` to select; defaults to Default.

Available types:
${getAgentTypesDescription()}

## Explicit invocation (\`/AgentName\`)

When the user invokes an agent by name — e.g. typing \`/SearchCodebase\` or \`/<custom-agent>\` — you MUST dispatch this tool with \`agent_type\` set to that exact name. This is a hard gate, not a preference:
1. Dispatch the agent before any text output.
2. Referencing the agent by name without dispatching it is forbidden.
3. The name maps directly to \`agent_type\`; do not fall back to \`Default\` when a specific agent was named.

## Agent selection

- **Read-only tasks** (browse, analyze, search, explain, list files, understand structure): use \`SearchCodebase\` — it's faster and lighter.
- **Write tasks** (create, edit, fix, refactor, multi-step modifications): use \`Default\`.

When in doubt: if the task requires NO file writes, prefer \`SearchCodebase\`.

## Prefer direct tools for simple tasks

If a ${TOOL_NAME_VIEW_FILE}, ${TOOL_NAME_SEARCH_FILES}, or ${TOOL_NAME_SEARCH_CONTENT} call can answer the question, use that instead — agents are for multi-step work, not single lookups.

## Execution model

**Parallel launch**: When multiple agents are independent, fire them all in one message — never sequentially.

**Foreground** (default): Block until result. Use when downstream work depends on the output.
**Background** (\`background: true\`): Fire and continue. You'll be notified on completion — do not poll or sleep.

## Prompting the agent

The agent has zero conversation context. Write its prompt as a self-contained brief:
- State the goal and why it matters
- Include file paths, line numbers, or specific findings you already have
- Specify whether it should write code or only research
- Keep scope tight — one clear deliverable per agent

## Handling results

Agent output is invisible to the user. Synthesize and relay key findings in your response.
`
}

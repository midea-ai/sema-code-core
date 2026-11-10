export const TOOL_DESCRIPTION: string = `Dispatch specialized skill modules during conversation.

Format:
- \`skill: "name"\` — basic call
- \`skill: "name", args: "value"\` — with arguments
- \`skill: "provider:name"\` — namespaced call
- \`skill: "name", file: "guides/x.md"\` — return a text file bundled with the skill (only for skills whose activation says so)

Behavior contract:
1. A matching skill MUST be dispatched before any text output — this is a hard gate, not a preference.
2. Referencing a skill by name without dispatching it is forbidden.
3. The tool result already contains the skill's full instructions. Never open its SKILL.md afterwards.`

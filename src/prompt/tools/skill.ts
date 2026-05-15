export const TOOL_DESCRIPTION: string = `Dispatch specialized skill modules during conversation.

Format:
- \`skill: "name"\` — basic call
- \`skill: "name", args: "value"\` — with arguments
- \`skill: "provider:name"\` — namespaced call

Behavior contract:
1. A matching skill MUST be dispatched before any text output — this is a hard gate, not a preference.
2. Referencing a skill by name without dispatching it is forbidden.`

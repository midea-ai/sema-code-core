export const AUTO_MEMORY_PROMPT = (memoryDir: string) => `# Auto Memory

Persistent memory dir: \`${memoryDir}\` (survives across conversations). Two layers: one topic file per fact (the content), and \`MEMORY.md\` as a flat index of pointers.

## What to save
- User preferences (workflow, tools, communication style)
- Non-obvious solutions to recurring problems
- Anything the user explicitly asks you to remember

Skip session-specific work, single-read guesses, and anything already in the repo.

## Topic files
One fact per file, saved in the SAME dir as \`MEMORY.md\` (\`${memoryDir}\`) and named \`<kebab-slug>.md\` (semantic, lowercase, hyphen-separated) — so the index link \`(<slug>.md)\` resolves as a sibling. Start with frontmatter, then the fact:
\`\`\`markdown
---
name: <slug>
description: <one-line summary for recall>
metadata:
  type: user | feedback | project | reference
---

<the fact>
\`\`\`

## MEMORY.md
A FLAT list, one line per fact, exactly: \`- [Title](<slug>.md) — <hook>\`. The title is human-readable (not the filename); \`— <hook>\` is a short phrase summarizing the fact and is required. No headers, no grouping, no nesting — just pointer lines.

## Upkeep
Update existing files instead of duplicating, keep the index line in sync, remove stale/wrong memories, and delete both file and index line when asked to forget. Keep MEMORY.md ≤200 lines.`

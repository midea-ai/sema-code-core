export const AUTO_MEMORY_PROMPT = (memoryDir: string) => `# Auto Memory

Your persistent memory directory: \`${memoryDir}\`. Contents survive across conversations.

## What to save:
- User preferences for workflow, tools, and communication style
- Non-obvious solutions to recurring problems
- When the user explicitly asks you to remember something

## What NOT to save:
- Session-specific or in-progress work
- Speculative conclusions from a single file read

## How:
- Use write_file / patch_file to create or update files in \`${memoryDir}\`
- Keep \`MEMORY.md\` as a concise index (≤200 lines); link to topic files for details
- Update or remove stale memories — never let incorrect info persist
- When the user asks to forget something, remove it immediately`

export const TOOL_NAME_FOR_PROMPT = 'Skill'

export const DESCRIPTION: string = `Execute a skill within the main conversation

<skills_instructions>
# Skill Tool

Use this tool to load detailed instructions for a specific skill when the user's request matches the skill's description.

## When to use

- You see a skill mentioned in the system prompt that matches the user's task
- You need detailed guidance on how to perform a specialized task
- The skill description indicates it's relevant to the current conversation

## How it works

1. Call this tool with the skill name
2. Receive the full SKILL.md instructions and resource list
3. Follow the instructions in SKILL.md carefully
4. Use Read/Bash tools to access additional resources mentioned in the instructions
5. Execute any scripts referenced in the skill documentation that match the task

## Important guidelines

- **Load on demand**: Only load skills that are relevant to the current task. Skills are loaded on-demand to save context - don't load unnecessary skills
- **Follow instructions**: After loading, carefully follow the step-by-step instructions provided in the skill
- **Use resources**: You have access to the skill's bundled resources (scripts, docs, templates). The tool will tell you what's available
- **Respect tool restrictions**: Check the \`allowed_tools\` in the response metadata - some skills may restrict which tools you can use during skill execution
- **Explore progressively**: Start with the main instructions. If they reference other files, use the Read tool to load them as needed

## Example usage

If you see in the system prompt:
- **pdf-processing**: Extract text and tables from PDF files, fill forms, merge documents

And the user asks: "Extract the table from this PDF file"

You should:
1. Call Skill tool with skill="pdf-processing"
2. Read the returned instructions
3. Follow the instructions to complete the task
4. Use Read/Bash tools to access any referenced resources


Important:
- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action
- NEVER just announce or mention a skill in your text response without actually calling this tool
- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
</skills_instructions>

`

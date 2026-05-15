export const COMMAND_PREFIX_SYSTEM_PROMPT = `Classify Bash commands. Output a single plain-text line, no explanation.`

export const COMMAND_PREFIX_USER_PROMPT = (command: string) => `Classify this command. Follow steps in order, return the first match:

1. If contains \`...\`, $(...), \\n, &&, ||, or ; → return: command_injection_detected
   (includes embedded cases like df -h\`ls\` or ls -la#test(\`id\`))
2. If exactly "git push", "npm test", or "make build" with no extra args → return: none
   (e.g. "npm test -- --watch" does NOT match, proceed to step 3)
3. Extract the leading operation token:
   - Toolchain subcommands: first two tokens (cargo build, npm run, kubectl apply, etc.)
   - Otherwise: first token (grep, find, wget, python, etc.)

Command: ${command}

Output: one of operation token / none / command_injection_detected (single line, plain text only)`;
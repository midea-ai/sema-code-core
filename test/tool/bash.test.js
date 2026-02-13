const { BashTool } = require('../../dist/tools/Bash/Bash');

const testCommand = 'ls';

async function main() {
    const abortController = new AbortController();
    const agentContext = { abortController };

    const input = { command: testCommand, timeout: 5000, description: 'List files in current directory' };

    for await (const result of BashTool.call(input, agentContext)) {
        if (result.type === 'result') {
            console.log(result.data.stdout);
        }
    }
}

main().catch(console.error).finally(() => process.exit(0));

const { GlobTool } = require('../../dist/tools/Glob/Glob');

const input = {
    pattern: '*.py',
    path: '/Users/zhoujie195/sema-demo'
};

async function main() {
    const abortController = new AbortController();
    const agentContext = { abortController };

    for await (const result of GlobTool.call(input, agentContext)) {
        if (result.type === 'result') {
            console.log('文件数量:', result.data.numFiles);
            console.log('匹配文件:', result.data.filenames.join('\n'));
        }
    }
}

main().catch(console.error).finally(() => process.exit(0));

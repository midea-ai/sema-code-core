const { GrepTool } = require('../../dist/tools/Grep/Grep');

const input = {
    pattern: 'quicksort',
    path: '/path/to/your/project', // 修改为你的项目路径
    output_mode: 'content'
};

async function main() {
    const abortController = new AbortController();
    const agentContext = { abortController };

    for await (const result of GrepTool.call(input, agentContext)) {
        if (result.type === 'result') {
            const actualMessage = GrepTool.genToolResultMessage(result.data);
            console.log('✅ 实际渲染结果:');
            console.log('title:', actualMessage.title);
            console.log('summary:', actualMessage.summary);
            console.log('content:', actualMessage.content);
        }
    }
}

main().catch(console.error).finally(() => process.exit(0));

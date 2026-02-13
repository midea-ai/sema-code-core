const { SemaCore } = require('../dist/core/SemaCore');

const core = new SemaCore({logLevel: 'none'});

const testModelConfig = {
  provider: 'deepseek',
  modelName: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-',
  maxTokens: 8192,
  contextLength: 128000
};

// const testModelConfig = {
//   provider: 'kimi',
//   modelName: 'kimi-k2.5',
//   baseURL: 'https://api.moonshot.cn/v1',
//   apiKey: 'sk-',
//   maxTokens: 8192,
//   contextLength: 128000
// };

// const testModelConfig = {
//   provider: 'minimax',
//   modelName: 'MiniMax-M2.1',
//   baseURL: 'https://api.minimaxi.com/anthropic',
//   apiKey: 'sk-',
//   maxTokens: 8192,
//   contextLength: 128000
// };

// const testModelConfig = {
//   provider: 'glm',
//   modelName: 'glm-4.7',
//   baseURL: 'https://open.bigmodel.cn/api/paas/v4',
//   apiKey: '',
//   maxTokens: 8192,
//   contextLength: 128000
// };

// const testModelConfig = {
//   provider: 'openrouter',
//   modelName: 'anthropic/claude-sonnet-4.5',
//   baseURL: 'https://openrouter.ai/api',
//   apiKey: 'sk-',
//   maxTokens: 8192,
//   contextLength: 128000
// };

async function runTests() {
  const modelId = `${testModelConfig.modelName}[${testModelConfig.provider}]`;
  try {
    console.log('添加模型:', JSON.stringify(await core.addModel(testModelConfig), null, 2));
    console.log('配置任务模型:', JSON.stringify(await core.applyTaskModel({ main: modelId, quick: modelId }), null, 2));
  } catch (error) {
    console.error('测试失败:', error.message);
  }
}

runTests().then(() => process.exit(0)).catch(() => process.exit(1));
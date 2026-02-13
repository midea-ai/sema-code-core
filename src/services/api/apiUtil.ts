import * as http from 'http';
import * as https from 'https';
import {
  ApiTestResult,
  ApiTestParams,
  FetchModelsResult,
  FetchModelsParams
} from '../../types';
import { resolveAdapter, TEMPERATURE_ONE_MODELS, useMaxCompletionTokens } from '../../util/adapter';

// ============ 通用 HTTP 请求工具 ============

interface HttpRequestOptions {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeout?: number;
}

interface HttpResponse {
  statusCode: number;
  data: string;
}

/**
 * 通用 HTTP 请求函数
 */
function httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const { url, method, headers, body, timeout = 10000 } = options;
  const urlObj = new URL(url);
  const isHttps = urlObj.protocol === 'https:';
  const httpModule = isHttps ? https : http;

  const requestHeaders = { ...headers };
  if (body) {
    requestHeaders['Content-Length'] = String(Buffer.byteLength(body));
  }

  const requestOptions = {
    hostname: urlObj.hostname,
    port: urlObj.port || (isHttps ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    method,
    headers: requestHeaders,
    timeout
  };

  return new Promise((resolve, reject) => {
    const req = httpModule.request(requestOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode || 0, data });
      });
    });

    req.on('error', (error) => reject(new Error(`连接失败: ${error.message}`)));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('连接超时，请检查网络或 API 地址是否正确'));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * 构建 API URL
 */
function buildApiUrl(baseURL: string, endpoint: string, adapter: string, provider?: string): string {
  let url = baseURL.replace(/\/$/, '');

  // 对于 OpenAI adapter，除了 glm 之外，都需要添加 /v1 前缀
  if (adapter === 'openai' && provider !== 'glm' && !url.endsWith('/v1')) {
    url = `${url}/v1`;
  }

  if (!url.endsWith(endpoint)) {
    url = `${url}${endpoint}`;
  }
  return url;
}

// ============ API 连接测试 ============

interface ApiConfig {
  endpoint: string;
  headers: (apiKey: string) => Record<string, string>;
  buildBody: (modelName: string) => object;
  extractContent: (response: any) => string;
  buildCurlHeaders: (apiKey: string) => string;
}

const API_CONFIGS: Record<string, ApiConfig> = {
  anthropic: {
    endpoint: '/v1/messages',
    headers: (apiKey) => ({
      'Content-Type': 'application/json',
      'x-api-key': apiKey
    }),
    buildBody: (modelName) => ({
      model: modelName,
      max_tokens: 1000,
      thinking: { type: "disabled" },
      messages: [{ role: 'user', content: 'Please respond with exactly "YES" (in capital letters) to confirm this connection is working.' }]
    }),
    extractContent: (response) => response.content?.find((b: any) => b.type === 'text')?.text || '',
    buildCurlHeaders: (apiKey) => `-H "x-api-key: ${apiKey}"`
  },
  openai: {
    endpoint: '/chat/completions',
    headers: (apiKey) => ({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    }),
    buildBody: (modelName) => ({
      model: modelName,
      messages: [{ role: 'user', content: 'Please respond with exactly "YES" (in capital letters) to confirm this connection is working.' }],
      ...(useMaxCompletionTokens(modelName) ? { max_completion_tokens: 200 } : { max_tokens: 200 }),
      temperature: TEMPERATURE_ONE_MODELS.includes(modelName) ? 1 : 0.0,
      stream: false
    }),
    extractContent: (response) => response.choices?.[0]?.message?.content || '',
    buildCurlHeaders: (apiKey) => `-H "Authorization: Bearer ${apiKey}"`
  }
};

/**
 * 构建 curl 命令用于调试
 */
function buildCurlCommand(apiUrl: string, apiKey: string, body: object, config: ApiConfig): string {
  return `curl ${apiUrl} \\
  -H "Content-Type: application/json" \\
  ${config.buildCurlHeaders(apiKey)} \\
  -d '${JSON.stringify(body, null, 2).replace(/'/g, "\\'")}'`;
}

/**
 * 测试 API 连接
 */
export async function testApiConnection(params: ApiTestParams): Promise<ApiTestResult> {
  const { provider = 'custom-openai', baseURL, apiKey, modelName } = params;
  const adapter = resolveAdapter(provider, modelName);
  console.log(`adapter: ${adapter}, ${provider}, ${modelName}`)
  const config = API_CONFIGS[adapter] || API_CONFIGS.openai;

  const apiUrl = buildApiUrl(baseURL, config.endpoint, adapter, provider);
  const body = config.buildBody(modelName);
  const curlCommand = buildCurlCommand(apiUrl, apiKey, body, config);

  try {
    const response = await httpRequest({
      url: apiUrl,
      method: 'POST',
      headers: config.headers(apiKey),
      body: JSON.stringify(body)
    });

    console.log('testApiConnection response:', response.statusCode, response.data.substring(0, 500));

    let result: ApiTestResult;

    if (response.statusCode === 200) {
      // 直接检查响应字符串中是否包含 "YES"，不做格式校验
      if (response.data.includes('YES')) {
        result = { success: true, message: '✓ 连接测试成功！API 配置正确。' };
      } else {
        result = { success: false, message: `✗ API 响应异常，未找到 YES 标识。响应: ${response.data.substring(0, 200)}`, curlCommand };
      }
    } else {
      const errorMessage = `✗ API 返回错误 (${response.statusCode}): ${response.data.substring(0, 500)}`;
      result = { success: false, message: errorMessage, curlCommand };
    }

    console.log('testApiConnection result:', JSON.stringify(result, null, 2));
    return result;

  } catch (error) {
    const result: ApiTestResult = {
      success: false,
      message: `✗ ${error instanceof Error ? error.message : String(error)}`,
      curlCommand
    };
    console.log('testApiConnection result:', JSON.stringify(result, null, 2));
    return result;
  }
}

// ============ 获取模型列表 ============

/** Anthropic 预定义模型列表 */
const MODEL_MAP = {
  anthropic: {
    baseURL: 'https://api.anthropic.com',
    models: [
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.6' },
      { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
      { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' }
    ]
  },
  minimax: {
    baseURL: 'https://api.minimaxi.com/anthropic',
    models: [
      { id: 'MiniMax-M2.5', name: 'MiniMax-M2.5' },
      { id: 'MiniMax-M2', name: 'MiniMax-M2' },
    ]
  }
};

/**
 * 获取可用模型列表
 */
export async function fetchModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const { provider = 'custom-openai', baseURL, apiKey } = params;

  let result: FetchModelsResult;

  // 仅当 baseURL 为默认值时，返回预定义模型列表
  const providerConfig = MODEL_MAP[provider as keyof typeof MODEL_MAP];
  if (providerConfig && baseURL === providerConfig.baseURL) {
    result = { success: true, models: providerConfig.models };
    console.log('fetchModels result:', JSON.stringify(result, null, 2));
    return result;
  }

  // 其他均按 OpenAI 标准获取
  const apiUrl = baseURL.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/models';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const curlCommand = `curl ${apiUrl} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}"`;

  console.log('curlCommand:', curlCommand)

  try {
    const response = await httpRequest({ url: apiUrl, method: 'GET', headers });

    if (response.statusCode === 200) {
      const jsonResponse = JSON.parse(response.data);
      const models = jsonResponse.data || [];

      console.log('models:', models)

      if (models.length === 0) {
        result = { success: false, message: '获取模型列表为空', curlCommand };
      } else {
        result = {
          success: true,
          models: models
        };
      }
    } else {
      result = { success: false, message: `获取模型列表失败 (${response.statusCode})`, curlCommand };
    }

  } catch (error) {
    result = {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      curlCommand
    };
  }

  console.log('fetchModels result:', JSON.stringify(result, null, 2));
  return result;
}

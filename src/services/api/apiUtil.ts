import * as http from 'http';
import * as https from 'https';
import {
  ApiTestResult,
  ApiTestParams,
  FetchModelsResult,
  FetchModelsParams
} from '../../types';
import { useMaxCompletionTokens } from '../../util/adapter';
import { API_CONNECTION_TEST_PROMPT } from '../../prompt/define';

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
  const { url, method, headers, body, timeout = 15000 } = options;
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
      reject(new Error('模型响应超时，请检查网络与模型服务状态'));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * 构建 API URL
 *
 * 仅当 adapter 为 openai 且 baseURL 路径中不存在 /vN 版本段时，自动追加 /v1。
 * 这样 GLM 的 /api/paas/v4、用户自填的 /v1/v2 等都不会被破坏。
 */
function buildApiUrl(baseURL: string, endpoint: string, adapter: string): string {
  let url = baseURL.replace(/\/$/, '');

  if (adapter === 'openai' && !/\/v\d+(\/|$)/.test(url)) {
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
      messages: [{ role: 'user', content: API_CONNECTION_TEST_PROMPT }]
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
      messages: [{ role: 'user', content: API_CONNECTION_TEST_PROMPT }],
      ...(useMaxCompletionTokens(modelName) ? { max_completion_tokens: 200 } : { max_tokens: 200 }),
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
  const { baseURL, apiKey, modelName, adapt } = params;
  const config = API_CONFIGS[adapt] || API_CONFIGS.openai;

  const apiUrl = buildApiUrl(baseURL, config.endpoint, adapt);
  const body = config.buildBody(modelName);
  const curlCommand = buildCurlCommand(apiUrl, apiKey, body, config);

  try {
    const response = await httpRequest({
      url: apiUrl,
      method: 'POST',
      headers: config.headers(apiKey),
      body: JSON.stringify(body)
    });

    // console.log('testApiConnection response:', response.statusCode, response.data.substring(0, 500));

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

    // console.log('testApiConnection result:', JSON.stringify(result, null, 2));
    return result;

  } catch (error) {
    const result: ApiTestResult = {
      success: false,
      message: `✗ ${error instanceof Error ? error.message : String(error)}`,
      curlCommand
    };
    // console.log('testApiConnection result:', JSON.stringify(result, null, 2));
    return result;
  }
}

// ============ 获取模型列表 ============

/** Anthropic 预定义模型列表 */
const MODEL_MAP = {
  anthropic: {
    baseURL: 'https://api.anthropic.com',
    models: [
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' }
    ]
  },
  minimax: {
    baseURL: 'https://api.minimaxi.com/anthropic',
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax-M3' },
      { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7' }
    ]
  }
};

/**
 * 获取可用模型列表
 *
 * - adapt === 'anthropic'：Anthropic 协议无标准 /models 接口，命中预设 provider 时返回预设列表，否则同 openai 流程
 * - adapt === 'openai'  ：调用标准 /models 端点
 */
export async function fetchModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const { provider = 'custom', baseURL, apiKey, adapt, modelsUrl } = params;

  let result: FetchModelsResult;

  // 命中预设 provider 时直接返回预设列表；custom 及自定义别名走下方 /models 请求
  if (adapt === 'anthropic' && !modelsUrl) {
    const providerConfig = MODEL_MAP[provider as keyof typeof MODEL_MAP];
    if (providerConfig) {
      return { success: true, models: providerConfig.models };
    }
  }

  // 优先使用 modelsUrl，否则按 OpenAI 协议拼接 /models 端点
  const apiUrl = modelsUrl
    ? modelsUrl
    : baseURL.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/models';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const curlCommand = `curl ${apiUrl} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}"`;

  // console.log('curlCommand:', curlCommand)

  try {
    const response = await httpRequest({ url: apiUrl, method: 'GET', headers });

    if (response.statusCode === 200) {
      const jsonResponse = JSON.parse(response.data);
      const models = jsonResponse.data || [];

      // console.log('models:', models)

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

  // console.log('fetchModels result:', JSON.stringify(result, null, 2));
  return result;
}

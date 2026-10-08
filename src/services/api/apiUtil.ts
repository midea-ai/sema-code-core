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
import { t } from '../../util/i18n';

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

    req.on('error', (error) => reject(new Error(t('model.connectFailed', { error: error.message }))));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(t('model.responseTimeout')));
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

/**
 * thinking 常开、不接受 { type: "disabled" } 的模型（传了会返回 400）：
 * Claude Fable / Mythos 全系，以及 Opus 5.5 起
 */
function thinkingAlwaysOn(modelName: string): boolean {
  const name = modelName.toLowerCase();
  if (/claude[-_\s]+(fable|mythos)/.test(name)) return true;

  const match = name.match(/claude[-_\s]+opus[-_\s]+(\d+)[-._\s]+(\d+)/);
  if (!match) return false;

  const majorVersion = Number(match[1]);
  const minorVersion = Number(match[2]);
  return majorVersion > 5 || (majorVersion === 5 && minorVersion >= 5);
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
      ...(thinkingAlwaysOn(modelName) ? {} : { thinking: { type: "disabled" } }),
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
        result = { success: true, message: t('model.testSuccess') };
      } else {
        result = { success: false, message: t('model.testNoYes', { response: response.data.substring(0, 200) }), curlCommand };
      }
    } else {
      const errorMessage = t('model.testHttpError', { status: response.statusCode, body: response.data.substring(0, 500) });
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

/**
 * 获取可用模型列表
 *
 * 只做远端请求，core 不内置任何模型列表；服务商不支持列出模型时返回 success: false，
 * 由上层应用决定用自带的内置列表兜底，还是引导手动输入。
 */
export async function fetchModels(params: FetchModelsParams): Promise<FetchModelsResult> {
  const { baseURL, apiKey, modelsUrl, adapt } = params;

  let result: FetchModelsResult;

  // 优先使用 modelsUrl，否则按 OpenAI 协议拼接 /models 端点
  const apiUrl = modelsUrl
    ? modelsUrl
    : baseURL.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/models';
  // 始终带 Bearer；Anthropic 适配时再加 x-api-key，两种头同时发、服务端各取所需：
  // DeepSeek/MiMo 虽是 Anthropic 适配但列表接口是 OpenAI 风格只认 Bearer，MiniMax 的 /anthropic/v1/models 只认 x-api-key
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
    if (adapt === 'anthropic') {
      headers['x-api-key'] = apiKey;
    }
  }

  const curlCommand = `curl ${apiUrl} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}"${adapt === 'anthropic' ? ` \\
  -H "x-api-key: ${apiKey}"` : ''}`;

  // console.log('curlCommand:', curlCommand)

  try {
    const response = await httpRequest({ url: apiUrl, method: 'GET', headers });

    if (response.statusCode === 200) {
      const jsonResponse = JSON.parse(response.data);
      const models = jsonResponse.data || [];

      // console.log('models:', models)

      if (models.length === 0) {
        result = { success: false, message: t('model.listEmpty'), curlCommand };
      } else {
        result = {
          success: true,
          models: models
        };
      }
    } else {
      result = { success: false, message: t('model.listFailed', { status: response.statusCode }), curlCommand };
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

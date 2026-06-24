# 添加新模型

本文档介绍如何在 SemaCore 中添加、管理和配置 AI 模型。

## 支持的模型服务商

SemaCore 支持多种主流 AI 模型服务商：

| 提供商 | 代表模型 | baseURL | SDK 适配类型 |
|--------|----------|----------|----------|
| deepseek | deepseek-v4-pro | https://api.deepseek.com/anthropic | anthropic |
| minimax | MiniMax-M3 | https://api.minimaxi.com/anthropic | anthropic |
| glm | glm-5.2 | https://open.bigmodel.cn/api/paas/v4 | openai |
| mimo | mimo-v2.5-pro | https://api.xiaomimimo.com/anthropic | anthropic |
| qwen | qwen3.7-max | https://dashscope.aliyuncs.com/compatible-mode/v1 | openai |
| kimi | kimi-k2.7-code | https://api.moonshot.cn/v1 | openai |
| custom | 自定义模型 | 自定义 | 自动检测 |

<figure align="center">
  <img src="https://github.com/midea-ai/sema-code-core/releases/download/docs-assets/model-config.png" alt="model-list">
  <figcaption>Sema Code VSCode 插件模型配置页面截图</figcaption>
</figure>

## ModelConfig 接口

```typescript
interface ModelConfig {
  provider: string      // 提供商名称
  modelName: string     // 提供商侧的模型 ID
  baseURL: string       // 自定义 API 端点地址
  apiKey: string        // API 密钥
  maxTokens: number     // 单次响应最大 token 数
  contextLength: number // 上下文窗口大小
  adapt?: 'anthropic' | 'openai'  // SDK 适配类型，可选，为空时自动检测
}
```

> **模型命名规则**：模型在内部以 `${modelName}[${provider}]` 作为唯一标识，例如 `deepseek-reasoner[deepseek]`。无需手动传入 `name` 字段，系统会自动生成。

## 添加模型

使用 `addModel` 方法添加新模型：

```javascript
await sema.addModel({
  provider: 'deepseek',
  modelName: 'deepseek-reasoner',
  baseURL: 'https://api.deepseek.com/anthropic',
  apiKey: 'sk-',
  maxTokens: 8192,
  contextLength: 128000,
})
```

### 参数说明

- `provider`: 服务提供商标识
- `modelName`: 模型在服务商侧的 ID
- `baseURL`: API 端点地址
- `apiKey`: API 认证密钥
- `maxTokens`: 最大输出 token 数
- `contextLength`: 上下文窗口大小
- `adapt`: API 适配器类型（可选），支持 `anthropic` 或 `openai`，为空时系统自动检测

### 自动检测逻辑

`adapt` 字段控制使用哪种 SDK 格式与提供商通信。SemaCore 会根据 provider 和 modelName 自动检测，检测逻辑位于 `src/util/adapter.ts`：

- **anthropic 适配器**：适用于 Anthropic、MiniMax、DeepSeek 等使用 Anthropic 格式 API 的服务商
- **openai 适配器**：默认适配器，适用于 OpenAI 格式 API

## 管理模型

### 切换当前使用的模型

使用 `switchModel` 方法切换主任务模型：

```javascript
await sema.switchModel('MiniMax-M2.5[minimax]')
```

### 删除模型

使用 `delModel` 方法删除已配置的模型：

```javascript
await sema.delModel('deepseek-reasoner[deepseek]')
```

> **注意**：如果模型正在被模型指针（main 或 quick）使用，则无法删除，需要先切换模型指针。

### 配置任务模型（主模型 + 快速模型）

系统支持两个模型指针：
- `main`：主任务模型，用于复杂的代码生成、分析等任务
- `quick`：快速任务模型，用于 bash 前缀提取、话题检测、探索子代理等轻量任务

```javascript
await sema.applyTaskModel({
  main: 'deepseek-v4-pro[deepseek]',   // 主任务使用
  quick: 'deepseek-v4-flash[deepseek]',   // 快速任务使用
})
```

### 获取模型数据

使用 `getModelData` 方法获取当前模型配置信息：

```javascript
const { modelName, modelList, taskConfig } = await sema.getModelData()
console.log('当前主模型:', modelName)            // 同 taskConfig.main
console.log('已配置模型列表:', modelList)         // string[]
console.log('主模型 / 快速模型:', taskConfig)     // { main, quick }
```

**ModelUpdateData 接口**：

```typescript
interface ModelUpdateData {
  modelName: string                       // 主模型名称
  modelList: string[]                     // 全部已配置的模型名称
  taskConfig: { 
    main: string;    // 主任务模型
    quick: string;   // 快速任务模型
  }
}
```

## 持久化

模型配置自动持久化到 `~/.sema/model.conf` 文件中：

```json
{
  "modelProfiles": [
    {
      "name": "deepseek-v4-flash[deepseek]",
      "provider": "deepseek",
      "modelName": "deepseek-v4-flash",
      "baseURL": "https://api.deepseek.com/anthropic",
      "apiKey": "sk-",
      "maxTokens": 16000,
      "contextLength": 256000,
      "adapt": "anthropic"
    },
    {
      "name": "deepseek-v4-pro[deepseek]",
      "provider": "deepseek",
      "modelName": "deepseek-v4-pro",
      "baseURL": "https://api.deepseek.com/anthropic",
      "apiKey": "sk-",
      "maxTokens": 32000,
      "contextLength": 256000,
      "adapt": "anthropic"
    }
  ],
  "modelPointers": {
    "main": "deepseek-v4-pro[deepseek]",
    "quick": "deepseek-v4-flash[deepseek]"
  }
}
```

下次创建 `SemaCore` 实例时，已保存的模型配置会自动加载，无需重新添加。

## 其他 API

### 验证 API 连接

添加模型前可先测试连通性：

```javascript
const result = await sema.testApiConnection({
  provider: 'kimi',
  baseURL: 'https://api.moonshot.cn/v1',
  apiKey: '',
  modelName: 'kimi-k2.5',
})

if (result.success) {
  console.log('连接成功')
} else { 
  console.error('连接失败:', `${result.message}\n调试命令：${result.curlCommand}`);
}
```

**ApiTestResult 接口**：

```typescript
interface ApiTestResult {
  success: boolean;      // 是否连接成功
  message: string;       // 响应消息
  curlCommand?: string;  // 调试用的 curl 命令
}
```

### 获取可用模型列表

从服务商获取可用的模型列表：

```javascript
const result = await sema.fetchAvailableModels({
  provider: 'kimi',
  baseURL: 'https://api.moonshot.cn/v1',
  apiKey: '',
})

if (result.success && result.models) {
  console.log('获取模型成功，共', result.models.length, '个模型')
  const modelIds = result.models.map(model => model.id)
  console.log('模型 ID 列表:', modelIds)
} else {
  console.error('获取模型失败:', `${result.message}\n调试命令：${result.curlCommand}`);
}
```
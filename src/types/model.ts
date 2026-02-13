// 模型管理器配置接口
export interface ModelConfiguration {
  modelProfiles: ModelProfile[];
  modelPointers: ModelPointers;
}

// API 适配器类型
export type AdapterType = 'openai' | 'anthropic'

// 模型配置接口
export interface ModelProfile {
  name: string              // 模型唯一标识  deepseek v3.1[custom-openai]
  provider: string          // 提供商：anthropic, openai, custom-openai 等
  modelName: string         // API 调用时使用的模型名 如：deepseek v3.1
  baseURL?: string          // 自定义 API 端点
  apiKey: string            // API 密钥
  maxTokens: number         // 最大输出 token
  contextLength: number     // 上下文窗口大小
  adapt?: AdapterType       // API 适配器类型（可选，为空时自动解析）
}

// 模型指针配置
export interface ModelPointers {
  main: string;             // 主任务模型
  quick: string;            // 快速模型
}

// 模型指针类型
export type ModelPointerType = 'main' | 'quick'


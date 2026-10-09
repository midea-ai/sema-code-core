// 文生图模型配置接口（与对话模型分开存放，见 ModelConfiguration.imageModelProfiles）
export interface ImageModelProfile {
  name: string              // 模型唯一标识  qwen-image-3.0[qwen]
  provider: string          // 提供商：volcengine, qwen, openrouter 等，命名规则同对话模型
  modelName: string         // API 调用时使用的模型名
  baseURL: string           // API 端点；以 /images 或 /images/generations 结尾时原样使用，否则追加 /images/generations
  apiKey: string            // API 密钥
}

// 添加文生图模型的入参
export interface ImageModelConfig {
  provider: string;
  modelName: string;
  baseURL: string;
  apiKey: string;
}

// 单张已落盘的生成图片
export interface GeneratedImage {
  filePath: string          // 本地绝对路径
  mediaType: string         // image/png 等，按文件头识别
  bytes: number
}

// 文生图调用结果
export interface ImageGenResult {
  images: GeneratedImage[]
  model: string             // 所用模型的 profile 名
  durationMs: number
}

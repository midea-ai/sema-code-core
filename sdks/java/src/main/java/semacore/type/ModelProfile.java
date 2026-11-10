// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

// getModelProfile 返回：磁盘上的完整模型 profile，供配置页编辑回填；host 模型的 apiKey 为空串
public record ModelProfile(String name, String provider, String modelName, String baseURL, String apiKey, long maxTokens, long contextLength, AdapterType adapt, ThinkingHistoryPolicy thinkingHistoryPolicy) {
}

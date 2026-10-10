// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

// getImageModelProfile 返回：磁盘上的完整文生图模型 profile；name 形如 qwen-image-3.0[qwen]
public record ImageModelProfile(String name, String provider, String modelName, String baseURL, String apiKey) {
}

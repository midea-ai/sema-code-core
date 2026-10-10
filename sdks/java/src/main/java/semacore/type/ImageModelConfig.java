// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

// addImageModel 入参：文生图模型（进程级，无会话级覆盖）
public record ImageModelConfig(String provider, String modelName, String baseURL, String apiKey) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String provider;
        private String modelName;
        private String baseURL;
        private String apiKey;
        private Builder() {}
        public Builder provider(String provider) { this.provider = provider; return this; }
        public Builder modelName(String modelName) { this.modelName = modelName; return this; }
        public Builder baseURL(String baseURL) { this.baseURL = baseURL; return this; }
        public Builder apiKey(String apiKey) { this.apiKey = apiKey; return this; }
        public ImageModelConfig build() { return new ImageModelConfig(provider, modelName, baseURL, apiKey); }
    }
}

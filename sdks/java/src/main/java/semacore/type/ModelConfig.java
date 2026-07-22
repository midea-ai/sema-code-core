// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record ModelConfig(String provider, String modelName, String baseURL, String apiKey, long maxTokens, long contextLength, AdapterType adapt) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String provider;
        private String modelName;
        private String baseURL;
        private String apiKey;
        private long maxTokens;
        private long contextLength;
        private AdapterType adapt;
        private Builder() {}
        public Builder provider(String provider) { this.provider = provider; return this; }
        public Builder modelName(String modelName) { this.modelName = modelName; return this; }
        public Builder baseURL(String baseURL) { this.baseURL = baseURL; return this; }
        public Builder apiKey(String apiKey) { this.apiKey = apiKey; return this; }
        public Builder maxTokens(long maxTokens) { this.maxTokens = maxTokens; return this; }
        public Builder contextLength(long contextLength) { this.contextLength = contextLength; return this; }
        public Builder adapt(AdapterType adapt) { this.adapt = adapt; return this; }
        public ModelConfig build() { return new ModelConfig(provider, modelName, baseURL, apiKey, maxTokens, contextLength, adapt); }
    }
}

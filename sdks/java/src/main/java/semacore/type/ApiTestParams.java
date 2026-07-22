// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record ApiTestParams(String baseURL, String apiKey, String modelName, AdapterType adapt, String provider) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String baseURL;
        private String apiKey;
        private String modelName;
        private AdapterType adapt;
        private String provider;
        private Builder() {}
        public Builder baseURL(String baseURL) { this.baseURL = baseURL; return this; }
        public Builder apiKey(String apiKey) { this.apiKey = apiKey; return this; }
        public Builder modelName(String modelName) { this.modelName = modelName; return this; }
        public Builder adapt(AdapterType adapt) { this.adapt = adapt; return this; }
        public Builder provider(String provider) { this.provider = provider; return this; }
        public ApiTestParams build() { return new ApiTestParams(baseURL, apiKey, modelName, adapt, provider); }
    }
}

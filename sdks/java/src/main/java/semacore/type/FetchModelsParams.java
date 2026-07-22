// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record FetchModelsParams(String baseURL, String apiKey, AdapterType adapt, String provider, String modelsUrl) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String baseURL;
        private String apiKey;
        private AdapterType adapt;
        private String provider;
        private String modelsUrl;
        private Builder() {}
        public Builder baseURL(String baseURL) { this.baseURL = baseURL; return this; }
        public Builder apiKey(String apiKey) { this.apiKey = apiKey; return this; }
        public Builder adapt(AdapterType adapt) { this.adapt = adapt; return this; }
        public Builder provider(String provider) { this.provider = provider; return this; }
        public Builder modelsUrl(String modelsUrl) { this.modelsUrl = modelsUrl; return this; }
        public FetchModelsParams build() { return new FetchModelsParams(baseURL, apiKey, adapt, provider, modelsUrl); }
    }
}

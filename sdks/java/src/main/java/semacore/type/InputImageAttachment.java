// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record InputImageAttachment(String type, String data, String media_type) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String type;
        private String data;
        private String media_type;
        private Builder() {}
        public Builder type(String type) { this.type = type; return this; }
        public Builder data(String data) { this.data = data; return this; }
        public Builder media_type(String media_type) { this.media_type = media_type; return this; }
        public InputImageAttachment build() { return new InputImageAttachment(type, data, media_type); }
    }
}

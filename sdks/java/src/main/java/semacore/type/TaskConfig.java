// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record TaskConfig(String main, String quick) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String main;
        private String quick;
        private Builder() {}
        public Builder main(String main) { this.main = main; return this; }
        public Builder quick(String quick) { this.quick = quick; return this; }
        public TaskConfig build() { return new TaskConfig(main, quick); }
    }
}

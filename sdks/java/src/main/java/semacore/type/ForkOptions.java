// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record ForkOptions(Boolean restoreFiles) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private Boolean restoreFiles;
        private Builder() {}
        public Builder restoreFiles(Boolean restoreFiles) { this.restoreFiles = restoreFiles; return this; }
        public ForkOptions build() { return new ForkOptions(restoreFiles); }
    }
}

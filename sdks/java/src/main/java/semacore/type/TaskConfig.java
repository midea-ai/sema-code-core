// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

// image：文生图模型指针，只在返回值里出现（空串/null 表示未启用）；applyTaskModel 入参只用 main/quick
public record TaskConfig(String main, String quick, String image) {
    public TaskConfig(String main, String quick) { this(main, quick, null); }
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String main;
        private String quick;
        private Builder() {}
        public Builder main(String main) { this.main = main; return this; }
        public Builder quick(String quick) { this.quick = quick; return this; }
        public TaskConfig build() { return new TaskConfig(main, quick, null); }
    }
}

// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/** 宿主内置的子代理：items 内联、dirs 为产品自带的明文目录（每个目录下是 &lt;name&gt;.md） */
public record AgentsInput(List<AgentInput> items, List<String> dirs) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private List<AgentInput> items;
        private List<String> dirs;
        private Builder() {}
        public Builder items(List<AgentInput> items) { this.items = items; return this; }
        public Builder dirs(List<String> dirs) { this.dirs = dirs; return this; }
        public AgentsInput build() { return new AgentsInput(items, dirs); }
    }
}

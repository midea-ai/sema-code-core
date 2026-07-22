// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

import java.util.List;
import java.util.Map;

public record ToolPermissionResponse(String toolId, String toolName, String selected) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String toolId;
        private String toolName;
        private String selected;
        private Builder() {}
        public Builder toolId(String toolId) { this.toolId = toolId; return this; }
        public Builder toolName(String toolName) { this.toolName = toolName; return this; }
        public Builder selected(String selected) { this.selected = selected; return this; }
        public ToolPermissionResponse build() { return new ToolPermissionResponse(toolId, toolName, selected); }
    }
}

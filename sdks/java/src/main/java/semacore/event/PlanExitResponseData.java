// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

import java.util.List;
import java.util.Map;

public record PlanExitResponseData(String agentId, String selected) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String agentId;
        private String selected;
        private Builder() {}
        public Builder agentId(String agentId) { this.agentId = agentId; return this; }
        public Builder selected(String selected) { this.selected = selected; return this; }
        public PlanExitResponseData build() { return new PlanExitResponseData(agentId, selected); }
    }
}

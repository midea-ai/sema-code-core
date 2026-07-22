// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

import java.util.List;
import java.util.Map;

public record PickOptionResponseData(String agentId, String answers) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String agentId;
        private String answers;
        private Builder() {}
        public Builder agentId(String agentId) { this.agentId = agentId; return this; }
        public Builder answers(String answers) { this.answers = answers; return this; }
        public PickOptionResponseData build() { return new PickOptionResponseData(agentId, answers); }
    }
}

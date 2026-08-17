// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/** mainModel / quickModel：会话级模型覆盖（profile 名，同 switchModel 参数），仅本会话生效、不持久化；null 沿用全局配置。 */
public record CreateSessionOptions(String sessionId, AgentMode agentMode, PermissionLevel permissionLevel,
                                   String mainModel, String quickModel) {
    public CreateSessionOptions(String sessionId, AgentMode agentMode, PermissionLevel permissionLevel) {
        this(sessionId, agentMode, permissionLevel, null, null);
    }
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String sessionId;
        private AgentMode agentMode;
        private PermissionLevel permissionLevel;
        private String mainModel;
        private String quickModel;
        private Builder() {}
        public Builder sessionId(String sessionId) { this.sessionId = sessionId; return this; }
        public Builder agentMode(AgentMode agentMode) { this.agentMode = agentMode; return this; }
        public Builder permissionLevel(PermissionLevel permissionLevel) { this.permissionLevel = permissionLevel; return this; }
        public Builder mainModel(String mainModel) { this.mainModel = mainModel; return this; }
        public Builder quickModel(String quickModel) { this.quickModel = quickModel; return this; }
        public CreateSessionOptions build() { return new CreateSessionOptions(sessionId, agentMode, permissionLevel, mainModel, quickModel); }
    }
}

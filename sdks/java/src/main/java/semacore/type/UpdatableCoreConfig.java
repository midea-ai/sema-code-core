// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record UpdatableCoreConfig(Boolean stream, Boolean thinking, String systemPrompt, String customRules, Boolean skipFileEditPermission, Boolean skipShellExecPermission, Boolean skipSkillPermission, Boolean skipMCPToolPermission, Boolean skipFetchUrlPermission, Boolean skipExternalFileReadPermission, Boolean enableLLMCache, Boolean disableBackgroundTasks) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private Boolean stream;
        private Boolean thinking;
        private String systemPrompt;
        private String customRules;
        private Boolean skipFileEditPermission;
        private Boolean skipShellExecPermission;
        private Boolean skipSkillPermission;
        private Boolean skipMCPToolPermission;
        private Boolean skipFetchUrlPermission;
        private Boolean skipExternalFileReadPermission;
        private Boolean enableLLMCache;
        private Boolean disableBackgroundTasks;
        private Builder() {}
        public Builder stream(Boolean stream) { this.stream = stream; return this; }
        public Builder thinking(Boolean thinking) { this.thinking = thinking; return this; }
        public Builder systemPrompt(String systemPrompt) { this.systemPrompt = systemPrompt; return this; }
        public Builder customRules(String customRules) { this.customRules = customRules; return this; }
        public Builder skipFileEditPermission(Boolean skipFileEditPermission) { this.skipFileEditPermission = skipFileEditPermission; return this; }
        public Builder skipShellExecPermission(Boolean skipShellExecPermission) { this.skipShellExecPermission = skipShellExecPermission; return this; }
        public Builder skipSkillPermission(Boolean skipSkillPermission) { this.skipSkillPermission = skipSkillPermission; return this; }
        public Builder skipMCPToolPermission(Boolean skipMCPToolPermission) { this.skipMCPToolPermission = skipMCPToolPermission; return this; }
        public Builder skipFetchUrlPermission(Boolean skipFetchUrlPermission) { this.skipFetchUrlPermission = skipFetchUrlPermission; return this; }
        public Builder skipExternalFileReadPermission(Boolean skipExternalFileReadPermission) { this.skipExternalFileReadPermission = skipExternalFileReadPermission; return this; }
        public Builder enableLLMCache(Boolean enableLLMCache) { this.enableLLMCache = enableLLMCache; return this; }
        public Builder disableBackgroundTasks(Boolean disableBackgroundTasks) { this.disableBackgroundTasks = disableBackgroundTasks; return this; }
        public UpdatableCoreConfig build() { return new UpdatableCoreConfig(stream, thinking, systemPrompt, customRules, skipFileEditPermission, skipShellExecPermission, skipSkillPermission, skipMCPToolPermission, skipFetchUrlPermission, skipExternalFileReadPermission, enableLLMCache, disableBackgroundTasks); }
    }
}

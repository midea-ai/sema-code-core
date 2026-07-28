// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record SemaCoreConfig(String workingDir, String logLevel, Boolean stream, Boolean thinking, String systemPrompt, SystemPromptMode systemPromptMode, String customRules, Boolean skipFileEditPermission, Boolean skipShellExecPermission, Boolean skipSkillPermission, Boolean skipMCPToolPermission, Boolean skipFetchUrlPermission, Boolean skipExternalFileReadPermission, Boolean enableLLMCache, List<String> useTools, List<String> disabledTools, AgentMode agentMode, Boolean disableTopicDetection, Boolean disableBackgroundTasks, Boolean enableToolSearch, List<String> toolSearchDefaultTools, Long maxSessions) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String workingDir;
        private String logLevel;
        private Boolean stream;
        private Boolean thinking;
        private String systemPrompt;
        private SystemPromptMode systemPromptMode;
        private String customRules;
        private Boolean skipFileEditPermission;
        private Boolean skipShellExecPermission;
        private Boolean skipSkillPermission;
        private Boolean skipMCPToolPermission;
        private Boolean skipFetchUrlPermission;
        private Boolean skipExternalFileReadPermission;
        private Boolean enableLLMCache;
        private List<String> useTools;
        private List<String> disabledTools;
        private AgentMode agentMode;
        private Boolean disableTopicDetection;
        private Boolean disableBackgroundTasks;
        private Boolean enableToolSearch;
        private List<String> toolSearchDefaultTools;
        private Long maxSessions;
        private Builder() {}
        public Builder workingDir(String workingDir) { this.workingDir = workingDir; return this; }
        public Builder logLevel(String logLevel) { this.logLevel = logLevel; return this; }
        public Builder stream(Boolean stream) { this.stream = stream; return this; }
        public Builder thinking(Boolean thinking) { this.thinking = thinking; return this; }
        public Builder systemPrompt(String systemPrompt) { this.systemPrompt = systemPrompt; return this; }
        public Builder systemPromptMode(SystemPromptMode systemPromptMode) { this.systemPromptMode = systemPromptMode; return this; }
        public Builder customRules(String customRules) { this.customRules = customRules; return this; }
        public Builder skipFileEditPermission(Boolean skipFileEditPermission) { this.skipFileEditPermission = skipFileEditPermission; return this; }
        public Builder skipShellExecPermission(Boolean skipShellExecPermission) { this.skipShellExecPermission = skipShellExecPermission; return this; }
        public Builder skipSkillPermission(Boolean skipSkillPermission) { this.skipSkillPermission = skipSkillPermission; return this; }
        public Builder skipMCPToolPermission(Boolean skipMCPToolPermission) { this.skipMCPToolPermission = skipMCPToolPermission; return this; }
        public Builder skipFetchUrlPermission(Boolean skipFetchUrlPermission) { this.skipFetchUrlPermission = skipFetchUrlPermission; return this; }
        public Builder skipExternalFileReadPermission(Boolean skipExternalFileReadPermission) { this.skipExternalFileReadPermission = skipExternalFileReadPermission; return this; }
        public Builder enableLLMCache(Boolean enableLLMCache) { this.enableLLMCache = enableLLMCache; return this; }
        public Builder useTools(List<String> useTools) { this.useTools = useTools; return this; }
        public Builder disabledTools(List<String> disabledTools) { this.disabledTools = disabledTools; return this; }
        public Builder agentMode(AgentMode agentMode) { this.agentMode = agentMode; return this; }
        public Builder disableTopicDetection(Boolean disableTopicDetection) { this.disableTopicDetection = disableTopicDetection; return this; }
        public Builder disableBackgroundTasks(Boolean disableBackgroundTasks) { this.disableBackgroundTasks = disableBackgroundTasks; return this; }
        public Builder enableToolSearch(Boolean enableToolSearch) { this.enableToolSearch = enableToolSearch; return this; }
        public Builder toolSearchDefaultTools(List<String> toolSearchDefaultTools) { this.toolSearchDefaultTools = toolSearchDefaultTools; return this; }
        public Builder maxSessions(Long maxSessions) { this.maxSessions = maxSessions; return this; }
        public SemaCoreConfig build() { return new SemaCoreConfig(workingDir, logLevel, stream, thinking, systemPrompt, systemPromptMode, customRules, skipFileEditPermission, skipShellExecPermission, skipSkillPermission, skipMCPToolPermission, skipFetchUrlPermission, skipExternalFileReadPermission, enableLLMCache, useTools, disabledTools, agentMode, disableTopicDetection, disableBackgroundTasks, enableToolSearch, toolSearchDefaultTools, maxSessions); }
    }
}

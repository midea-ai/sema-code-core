// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/**
 * SemaCore 构造配置（init payload）；全字段可选（null 即不传）。
 * models / mcpServers / hooks / skills / agents / commands 为宿主传入的 host 域内容（只读、同名盖掉其他域、不落盘），
 * scopes 指定每一类哪些域生效，encryption 开启历史 / 快照 / hook 记录加密；这些都只在构造时生效，校验不通过 start 抛 CONFIG_INVALID。
 */
public record SemaCoreConfig(String workingDir, String logLevel, String lang, Boolean stream, Boolean thinking, String systemPrompt, SystemPromptMode systemPromptMode, String customRules, Boolean skipFileEditPermission, Boolean skipShellExecPermission, Boolean skipSkillPermission, Boolean skipMCPToolPermission, Boolean skipFetchUrlPermission, Boolean fetchUrlBrowserUserAgent, Boolean skipExternalFileReadPermission, List<String> useTools, List<String> disabledTools, AgentMode agentMode, Boolean disableTopicDetection, Boolean enableInputPrediction, Boolean disableBackgroundTasks, Boolean disableMemory, Boolean enableToolSearch, List<String> toolSearchDefaultTools, Long maxSessions, String usageProduct, ModelsInput models, List<MCPServerInput> mcpServers, Map<String, List<HookGroupInput>> hooks, SkillsInput skills, AgentsInput agents, CommandsInput commands, ScopesConfig scopes, EncryptionConfig encryption, Boolean disableLLMLog, Boolean disableEventLog, String configFile) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String workingDir;
        private String logLevel;
        private String lang;
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
        private Boolean fetchUrlBrowserUserAgent;
        private Boolean skipExternalFileReadPermission;
        private List<String> useTools;
        private List<String> disabledTools;
        private AgentMode agentMode;
        private Boolean disableTopicDetection;
        private Boolean enableInputPrediction;
        private Boolean disableBackgroundTasks;
        private Boolean disableMemory;
        private Boolean enableToolSearch;
        private List<String> toolSearchDefaultTools;
        private Long maxSessions;
        private String usageProduct;
        private ModelsInput models;
        private List<MCPServerInput> mcpServers;
        private Map<String, List<HookGroupInput>> hooks;
        private SkillsInput skills;
        private AgentsInput agents;
        private CommandsInput commands;
        private ScopesConfig scopes;
        private EncryptionConfig encryption;
        private Boolean disableLLMLog;
        private Boolean disableEventLog;
        private String configFile;
        private Builder() {}
        public Builder workingDir(String workingDir) { this.workingDir = workingDir; return this; }
        public Builder logLevel(String logLevel) { this.logLevel = logLevel; return this; }
        public Builder lang(String lang) { this.lang = lang; return this; }
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
        public Builder fetchUrlBrowserUserAgent(Boolean fetchUrlBrowserUserAgent) { this.fetchUrlBrowserUserAgent = fetchUrlBrowserUserAgent; return this; }
        public Builder skipExternalFileReadPermission(Boolean skipExternalFileReadPermission) { this.skipExternalFileReadPermission = skipExternalFileReadPermission; return this; }
        public Builder useTools(List<String> useTools) { this.useTools = useTools; return this; }
        public Builder disabledTools(List<String> disabledTools) { this.disabledTools = disabledTools; return this; }
        public Builder agentMode(AgentMode agentMode) { this.agentMode = agentMode; return this; }
        public Builder disableTopicDetection(Boolean disableTopicDetection) { this.disableTopicDetection = disableTopicDetection; return this; }
        /** 一轮结束后用 quick 模型预测用户下一句（事件 input:predict），默认否。 */
        public Builder enableInputPrediction(Boolean enableInputPrediction) { this.enableInputPrediction = enableInputPrediction; return this; }
        public Builder disableBackgroundTasks(Boolean disableBackgroundTasks) { this.disableBackgroundTasks = disableBackgroundTasks; return this; }
        /** 关闭内置记忆（不拼记忆提示词、不注入 MEMORY.md、不读 .sema/memory、记忆文件编辑豁免失效）。仅构造时生效。 */
        public Builder disableMemory(Boolean disableMemory) { this.disableMemory = disableMemory; return this; }
        public Builder enableToolSearch(Boolean enableToolSearch) { this.enableToolSearch = enableToolSearch; return this; }
        public Builder toolSearchDefaultTools(List<String> toolSearchDefaultTools) { this.toolSearchDefaultTools = toolSearchDefaultTools; return this; }
        public Builder maxSessions(Long maxSessions) { this.maxSessions = maxSessions; return this; }
        /** 使用统计的产品标识（如 sema-code-vscode）；不传或空串则本进程不采集。仅构造时生效。 */
        public Builder usageProduct(String usageProduct) { this.usageProduct = usageProduct; return this; }
        /** 宿主内置的模型与指针；host 模型只读，查询接口不回传 apiKey。 */
        public Builder models(ModelsInput models) { this.models = models; return this; }
        /** 宿主内置的 MCP 服务；查询接口与状态事件里 env / headers 值打码。 */
        public Builder mcpServers(List<MCPServerInput> mcpServers) { this.mcpServers = mcpServers; return this; }
        /** 宿主内置的 hook：即 hooks.json 里 hooks 字段的内容，键为事件名。 */
        public Builder hooks(Map<String, List<HookGroupInput>> hooks) { this.hooks = hooks; return this; }
        /** 宿主内置的 skill：items 内联（正文只在内存）、dirs 明文目录。 */
        public Builder skills(SkillsInput skills) { this.skills = skills; return this; }
        /** 宿主内置的子代理，结构同 skills。 */
        public Builder agents(AgentsInput agents) { this.agents = agents; return this; }
        /** 宿主内置的命令，结构同 skills。 */
        public Builder commands(CommandsInput commands) { this.commands = commands; return this; }
        /** 各类生效的域，不写 = 全部生效。 */
        public Builder scopes(ScopesConfig scopes) { this.scopes = scopes; return this; }
        /** 会话历史、hook 会话记录、快照加密；密钥只在内存。仅构造时生效。 */
        public Builder encryption(EncryptionConfig encryption) { this.encryption = encryption; return this; }
        /** 不写模型调用日志；缺省：没传 encryption 为 false，传了为 true。支持运行期更新。 */
        public Builder disableLLMLog(Boolean disableLLMLog) { this.disableLLMLog = disableLLMLog; return this; }
        /** 不写事件日志；缺省规则同 disableLLMLog。支持运行期更新。 */
        public Builder disableEventLog(Boolean disableEventLog) { this.disableEventLog = disableEventLog; return this; }
        /** 构造配置文件路径（~/xx 或绝对路径，由桥进程读取）：严格 JSON，字段同本类型；这里显式传的顶层键整体覆盖文件里的同名键；文件内 {"$file": "路径"} 替换为该文件文本。 */
        public Builder configFile(String configFile) { this.configFile = configFile; return this; }
        public SemaCoreConfig build() { return new SemaCoreConfig(workingDir, logLevel, lang, stream, thinking, systemPrompt, systemPromptMode, customRules, skipFileEditPermission, skipShellExecPermission, skipSkillPermission, skipMCPToolPermission, skipFetchUrlPermission, fetchUrlBrowserUserAgent, skipExternalFileReadPermission, useTools, disabledTools, agentMode, disableTopicDetection, enableInputPrediction, disableBackgroundTasks, disableMemory, enableToolSearch, toolSearchDefaultTools, maxSessions, usageProduct, models, mcpServers, hooks, skills, agents, commands, scopes, encryption, disableLLMLog, disableEventLog, configFile); }
    }
}

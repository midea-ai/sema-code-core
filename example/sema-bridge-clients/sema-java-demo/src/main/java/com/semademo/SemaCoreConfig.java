package com.semademo;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * SemaCore 初始化配置，对应 sema-core 的 SemaCoreConfig 接口
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class SemaCoreConfig {

    /** Agent 操作的目标代码仓库绝对路径 */
    @JsonProperty("workingDir")
    public String workingDir;

    /** 日志级别，默认 info */
    @JsonProperty("logLevel")
    public String logLevel;

    /** 流式输出 AI 响应，默认 true */
    @JsonProperty("stream")
    public Boolean stream;

    /** 输出思考过程，默认 false */
    @JsonProperty("thinking")
    public Boolean thinking;

    /** 系统提示词 */
    @JsonProperty("systemPrompt")
    public String systemPrompt;

    /** 用户自定义规则 */
    @JsonProperty("customRules")
    public String customRules;

    /** 跳过文件编辑权限检查，默认 false */
    @JsonProperty("skipFileEditPermission")
    public Boolean skipFileEditPermission;

    /** 跳过 Shell 执行权限检查，默认 false */
    @JsonProperty("skipShellExecPermission")
    public Boolean skipShellExecPermission;

    /** 跳过 Skill 权限检查，默认 false */
    @JsonProperty("skipSkillPermission")
    public Boolean skipSkillPermission;

    /** 跳过 MCP 工具权限检查，默认 false */
    @JsonProperty("skipMCPToolPermission")
    public Boolean skipMCPToolPermission;

    /** 开启 LLM 缓存，默认 false，建议只在重复测试时使用 */
    @JsonProperty("enableLLMCache")
    public Boolean enableLLMCache;

    /** 跳过 fetch_url 权限检查，默认 false */
    @JsonProperty("skipFetchUrlPermission")
    public Boolean skipFetchUrlPermission;

    /** 跳过项目外文件读取权限检查，默认 false */
    @JsonProperty("skipExternalFileReadPermission")
    public Boolean skipExternalFileReadPermission;

    /** 限定使用的工具列表（白名单），null 表示使用所有工具 */
    @JsonProperty("useTools")
    public String[] useTools;

    /** 禁用的工具列表（黑名单），null 表示不禁用。与 useTools 同时传时优先生效 */
    @JsonProperty("disabledTools")
    public String[] disabledTools;

    /** Agent 模式：Agent 或 Plan，默认 Agent */
    @JsonProperty("agentMode")
    public String agentMode;

    /** 是否禁用话题检测，默认 false */
    @JsonProperty("disableTopicDetection")
    public Boolean disableTopicDetection;

    /** 是否禁止后台任务，默认 false */
    @JsonProperty("disableBackgroundTasks")
    public Boolean disableBackgroundTasks;

    public static Builder builder() {
        return new Builder();
    }

    public static class Builder {
        private final SemaCoreConfig c = new SemaCoreConfig();

        public Builder workingDir(String v)              { c.workingDir = v;              return this; }
        public Builder logLevel(String v)                { c.logLevel = v;                return this; }
        public Builder stream(Boolean v)                 { c.stream = v;                  return this; }
        public Builder thinking(Boolean v)               { c.thinking = v;                return this; }
        public Builder systemPrompt(String v)            { c.systemPrompt = v;            return this; }
        public Builder customRules(String v)             { c.customRules = v;             return this; }
        public Builder skipFileEditPermission(Boolean v) { c.skipFileEditPermission = v;  return this; }
        public Builder skipShellExecPermission(Boolean v) { c.skipShellExecPermission = v;  return this; }
        public Builder skipSkillPermission(Boolean v)     { c.skipSkillPermission = v;      return this; }
        public Builder skipMCPToolPermission(Boolean v)   { c.skipMCPToolPermission = v;    return this; }
        public Builder skipFetchUrlPermission(Boolean v)  { c.skipFetchUrlPermission = v;   return this; }
        public Builder skipExternalFileReadPermission(Boolean v) { c.skipExternalFileReadPermission = v; return this; }
        public Builder enableLLMCache(Boolean v)          { c.enableLLMCache = v;           return this; }
        public Builder useTools(String... v)              { c.useTools = v;                 return this; }
        public Builder disabledTools(String... v)         { c.disabledTools = v;            return this; }
        public Builder agentMode(String v)                { c.agentMode = v;                return this; }
        public Builder disableTopicDetection(Boolean v)   { c.disableTopicDetection = v;    return this; }
        public Builder disableBackgroundTasks(Boolean v)  { c.disableBackgroundTasks = v;   return this; }

        public SemaCoreConfig build() { return c; }
    }
}

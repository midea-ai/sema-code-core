// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/**
 * 内联子代理（字段同 addAgentConf 入参，去掉 locate）。
 * tools 为 List&lt;String&gt; 或字符串 "*"（默认 "*"）；model 为 "quick" 对应快速模型，其他值均对应主模型。
 */
public record AgentInput(String name, String description, String prompt, Object tools, String model) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private String description;
        private String prompt;
        private Object tools;
        private String model;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }
        public Builder tools(Object tools) { this.tools = tools; return this; }
        public Builder model(String model) { this.model = model; return this; }
        public AgentInput build() { return new AgentInput(name, description, prompt, tools, model); }
    }
}

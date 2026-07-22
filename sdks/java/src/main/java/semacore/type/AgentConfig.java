// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record AgentConfig(String name, String description, Object tools, String model, String prompt, AgentScope locate, String filePath) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private String description;
        private Object tools;
        private String model;
        private String prompt;
        private AgentScope locate;
        private String filePath;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder tools(Object tools) { this.tools = tools; return this; }
        public Builder model(String model) { this.model = model; return this; }
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }
        public Builder locate(AgentScope locate) { this.locate = locate; return this; }
        public Builder filePath(String filePath) { this.filePath = filePath; return this; }
        public AgentConfig build() { return new AgentConfig(name, description, tools, model, prompt, locate, filePath); }
    }
}

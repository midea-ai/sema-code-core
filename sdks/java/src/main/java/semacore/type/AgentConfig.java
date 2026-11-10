// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import com.google.gson.annotations.SerializedName;

import java.util.List;
import java.util.Map;

// isPrivate ↔ wire 字段 private（Java 关键字）：宿主内联传入的子代理，正文只在内存里，查询接口里 prompt 为空串、无 filePath
public record AgentConfig(String name, String description, Object tools, String model, String prompt, AgentScope locate, String filePath, @SerializedName("private") Boolean isPrivate) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private String description;
        private Object tools;
        private String model;
        private String prompt;
        private AgentScope locate;
        private String filePath;
        private Boolean isPrivate;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder tools(Object tools) { this.tools = tools; return this; }
        public Builder model(String model) { this.model = model; return this; }
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }
        public Builder locate(AgentScope locate) { this.locate = locate; return this; }
        public Builder filePath(String filePath) { this.filePath = filePath; return this; }
        public Builder isPrivate(Boolean isPrivate) { this.isPrivate = isPrivate; return this; }
        public AgentConfig build() { return new AgentConfig(name, description, tools, model, prompt, locate, filePath, isPrivate); }
    }
}

// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record SkillConfig(String name, String description, String prompt, SkillScope locate, String filePath, Boolean status) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private String description;
        private String prompt;
        private SkillScope locate;
        private String filePath;
        private Boolean status;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }
        public Builder locate(SkillScope locate) { this.locate = locate; return this; }
        public Builder filePath(String filePath) { this.filePath = filePath; return this; }
        public Builder status(Boolean status) { this.status = status; return this; }
        public SkillConfig build() { return new SkillConfig(name, description, prompt, locate, filePath, status); }
    }
}

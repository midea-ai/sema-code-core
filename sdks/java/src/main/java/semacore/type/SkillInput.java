// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/**
 * 内联 skill：正文与文本子文件只在内存里，磁盘上不留。
 * prompt 为 SKILL.md 正文；files 为文本子文件（相对路径 → 内容，模型用 skill 工具的 file 参数读）；
 * resourceDir 为脚本、图片、模板等所在的磁盘目录（绝对路径），不保护。
 */
public record SkillInput(String name, String description, String prompt, Map<String,String> files, String resourceDir) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private String description;
        private String prompt;
        private Map<String,String> files;
        private String resourceDir;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }
        public Builder files(Map<String,String> files) { this.files = files; return this; }
        public Builder resourceDir(String resourceDir) { this.resourceDir = resourceDir; return this; }
        public SkillInput build() { return new SkillInput(name, description, prompt, files, resourceDir); }
    }
}

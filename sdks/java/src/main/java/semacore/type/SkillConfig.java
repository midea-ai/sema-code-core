// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import com.google.gson.annotations.SerializedName;

import java.util.List;
import java.util.Map;

// status：是否启用（settings 的 disabledSkills 控制；null 视为启用；builtin / host 恒为启用）
// isPrivate ↔ wire 字段 private（Java 关键字）：宿主内联传入的 skill，正文与文本子文件只在内存里，查询接口里 prompt 为空串、无 filePath
// resourceDir：内联 skill 的脚本、资源所在磁盘目录（绝对路径）
public record SkillConfig(String name, String description, String prompt, SkillScope locate, String filePath, Boolean status, @SerializedName("private") Boolean isPrivate, String resourceDir) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private String description;
        private String prompt;
        private SkillScope locate;
        private String filePath;
        private Boolean status;
        private Boolean isPrivate;
        private String resourceDir;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }
        public Builder locate(SkillScope locate) { this.locate = locate; return this; }
        public Builder filePath(String filePath) { this.filePath = filePath; return this; }
        public Builder status(Boolean status) { this.status = status; return this; }
        public Builder isPrivate(Boolean isPrivate) { this.isPrivate = isPrivate; return this; }
        public Builder resourceDir(String resourceDir) { this.resourceDir = resourceDir; return this; }
        public SkillConfig build() { return new SkillConfig(name, description, prompt, locate, filePath, status, isPrivate, resourceDir); }
    }
}

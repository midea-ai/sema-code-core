// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import com.google.gson.annotations.SerializedName;

import java.util.List;
import java.util.Map;

// isPrivate ↔ wire 字段 private（Java 关键字）：宿主内联传入的命令，正文只在内存里，查询接口里 prompt 为空串、无 filePath
public record CommandConfig(String name, String description, String prompt, Object argumentHint, CommandScope locate, String filePath, @SerializedName("private") Boolean isPrivate) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private String description;
        private String prompt;
        private Object argumentHint;
        private CommandScope locate;
        private String filePath;
        private Boolean isPrivate;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder prompt(String prompt) { this.prompt = prompt; return this; }
        public Builder argumentHint(Object argumentHint) { this.argumentHint = argumentHint; return this; }
        public Builder locate(CommandScope locate) { this.locate = locate; return this; }
        public Builder filePath(String filePath) { this.filePath = filePath; return this; }
        public Builder isPrivate(Boolean isPrivate) { this.isPrivate = isPrivate; return this; }
        public CommandConfig build() { return new CommandConfig(name, description, prompt, argumentHint, locate, filePath, isPrivate); }
    }
}

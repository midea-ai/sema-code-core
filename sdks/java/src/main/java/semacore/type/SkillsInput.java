// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/** 宿主内置的 skill：items 内联（正文只在内存）、dirs 为产品自带的明文目录（每个目录下是 &lt;skill 名&gt;/SKILL.md） */
public record SkillsInput(List<SkillInput> items, List<String> dirs) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private List<SkillInput> items;
        private List<String> dirs;
        private Builder() {}
        public Builder items(List<SkillInput> items) { this.items = items; return this; }
        public Builder dirs(List<String> dirs) { this.dirs = dirs; return this; }
        public SkillsInput build() { return new SkillsInput(items, dirs); }
    }
}

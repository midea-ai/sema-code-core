// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/**
 * 宿主内置 hook 的一个 matcher 组（hooks.json 里 hooks[事件名][] 的元素）。
 * SemaCoreConfig.hooks 的类型是 Map&lt;String, List&lt;HookGroupInput&gt;&gt;，键为事件名（≙ core HooksInput）。
 */
public record HookGroupInput(String matcher, List<HookCommandInput> hooks) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String matcher;
        private List<HookCommandInput> hooks;
        private Builder() {}
        public Builder matcher(String matcher) { this.matcher = matcher; return this; }
        public Builder hooks(List<HookCommandInput> hooks) { this.hooks = hooks; return this; }
        public HookGroupInput build() { return new HookGroupInput(matcher, hooks); }
    }
}

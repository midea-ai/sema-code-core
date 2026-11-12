// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

// addHook 入参：写入 scope（user / project）对应层的 hooks.json
// matcher：仅工具类事件生效，缺省匹配全部工具；timeout：秒，缺省 60；failClosed：hook 执行失败时按阻断处理，缺省 false
public record HookConfig(HookScope scope, String event, String matcher, String command, Integer timeout, Boolean failClosed) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private HookScope scope;
        private String event;
        private String matcher;
        private String command;
        private Integer timeout;
        private Boolean failClosed;
        private Builder() {}
        public Builder scope(HookScope scope) { this.scope = scope; return this; }
        public Builder event(String event) { this.event = event; return this; }
        public Builder matcher(String matcher) { this.matcher = matcher; return this; }
        public Builder command(String command) { this.command = command; return this; }
        public Builder timeout(Integer timeout) { this.timeout = timeout; return this; }
        public Builder failClosed(Boolean failClosed) { this.failClosed = failClosed; return this; }
        public HookConfig build() { return new HookConfig(scope, event, matcher, command, timeout, failClosed); }
    }
}

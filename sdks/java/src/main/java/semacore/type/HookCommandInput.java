// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/** 宿主内置 hook 的一条命令（hooks.json 里 hooks[].hooks[] 的元素）；type 只支持 "command"，缺省即是；timeout 单位秒 */
public record HookCommandInput(String type, String command, Integer timeout, Boolean failClosed) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String type;
        private String command;
        private Integer timeout;
        private Boolean failClosed;
        private Builder() {}
        public Builder type(String type) { this.type = type; return this; }
        public Builder command(String command) { this.command = command; return this; }
        public Builder timeout(Integer timeout) { this.timeout = timeout; return this; }
        public Builder failClosed(Boolean failClosed) { this.failClosed = failClosed; return this; }
        public HookCommandInput build() { return new HookCommandInput(type, command, timeout, failClosed); }
    }
}

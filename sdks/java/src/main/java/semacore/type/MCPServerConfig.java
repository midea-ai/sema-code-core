// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record MCPServerConfig(String name, MCPTransportType transport, MCPScopeType scope, String description, Boolean enabled, List<String> useTools, String command, List<String> args, Map<String,String> env, String url, Map<String,String> headers) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private MCPTransportType transport;
        private MCPScopeType scope;
        private String description;
        private Boolean enabled;
        private List<String> useTools;
        private String command;
        private List<String> args;
        private Map<String,String> env;
        private String url;
        private Map<String,String> headers;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder transport(MCPTransportType transport) { this.transport = transport; return this; }
        public Builder scope(MCPScopeType scope) { this.scope = scope; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder enabled(Boolean enabled) { this.enabled = enabled; return this; }
        public Builder useTools(List<String> useTools) { this.useTools = useTools; return this; }
        public Builder command(String command) { this.command = command; return this; }
        public Builder args(List<String> args) { this.args = args; return this; }
        public Builder env(Map<String,String> env) { this.env = env; return this; }
        public Builder url(String url) { this.url = url; return this; }
        public Builder headers(Map<String,String> headers) { this.headers = headers; return this; }
        public MCPServerConfig build() { return new MCPServerConfig(name, transport, scope, description, enabled, useTools, command, args, env, url, headers); }
    }
}

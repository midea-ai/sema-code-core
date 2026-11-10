// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/**
 * 宿主内置的 MCP 服务（字段同 addMCPServer 入参，去掉 scope）；查询接口与 mcp:server:status 事件里 env / headers 值打码。
 * enabled 默认 true，不受 settings 的 disabledMcpServers 影响；useTools 为允许的工具名，null / 缺省表示全部。
 */
public record MCPServerInput(String name, MCPTransportType transport, String description, String command, List<String> args, Map<String,String> env, String url, Map<String,String> headers, Boolean enabled, List<String> useTools) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private String name;
        private MCPTransportType transport;
        private String description;
        private String command;
        private List<String> args;
        private Map<String,String> env;
        private String url;
        private Map<String,String> headers;
        private Boolean enabled;
        private List<String> useTools;
        private Builder() {}
        public Builder name(String name) { this.name = name; return this; }
        public Builder transport(MCPTransportType transport) { this.transport = transport; return this; }
        public Builder description(String description) { this.description = description; return this; }
        public Builder command(String command) { this.command = command; return this; }
        public Builder args(List<String> args) { this.args = args; return this; }
        public Builder env(Map<String,String> env) { this.env = env; return this; }
        public Builder url(String url) { this.url = url; return this; }
        public Builder headers(Map<String,String> headers) { this.headers = headers; return this; }
        public Builder enabled(Boolean enabled) { this.enabled = enabled; return this; }
        public Builder useTools(List<String> useTools) { this.useTools = useTools; return this; }
        public MCPServerInput build() { return new MCPServerInput(name, transport, description, command, args, env, url, headers, enabled, useTools); }
    }
}

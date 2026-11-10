// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/**
 * 各类生效的域；不写（null）= 该类全部域生效，要锁定必须显式写。值为域名字符串：
 * models: host / user；mcp、hooks、commands: host / user / project；skills、agents: host / builtin / user / project；
 * plugins 没有 host 域，值是插件安装位置（PluginScopeKind：user / project / local），空列表表示不加载任何插件。
 */
public record ScopesConfig(List<String> models, List<String> mcp, List<String> hooks, List<String> skills, List<String> agents, List<String> commands, List<PluginScopeKind> plugins) {
    public static Builder builder() { return new Builder(); }
    public static final class Builder {
        private List<String> models;
        private List<String> mcp;
        private List<String> hooks;
        private List<String> skills;
        private List<String> agents;
        private List<String> commands;
        private List<PluginScopeKind> plugins;
        private Builder() {}
        public Builder models(List<String> models) { this.models = models; return this; }
        public Builder mcp(List<String> mcp) { this.mcp = mcp; return this; }
        public Builder hooks(List<String> hooks) { this.hooks = hooks; return this; }
        public Builder skills(List<String> skills) { this.skills = skills; return this; }
        public Builder agents(List<String> agents) { this.agents = agents; return this; }
        public Builder commands(List<String> commands) { this.commands = commands; return this; }
        public Builder plugins(List<PluginScopeKind> plugins) { this.plugins = plugins; return this; }
        public ScopesConfig build() { return new ScopesConfig(models, mcp, hooks, skills, agents, commands, plugins); }
    }
}

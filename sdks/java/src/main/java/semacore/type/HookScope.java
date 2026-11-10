// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.type;

// host：宿主构造时传入，只读、无配置文件
public enum HookScope { host, user, project, plugin }

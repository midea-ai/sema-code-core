// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.type;

// host：宿主构造时传入的条目（只读，env / headers 对外打码）
public enum MCPScopeType { host, local, project, user, plugin }

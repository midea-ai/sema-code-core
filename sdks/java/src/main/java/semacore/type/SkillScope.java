// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.type;

// host：宿主构造时传入（内联或 dirs 目录），只读
public enum SkillScope { host, user, project, plugin, builtin }

// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/** 文件相对会话基线的状态；unchanged 与基线一致，unknown 无法判断（基线缺失或当前文件状态读不出来）。 */
public enum FileChangeState { modified, added, deleted, unchanged, unknown }

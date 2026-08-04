// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

public record HookEntryInfo(String event, HookScope source, String matcher, String command, Integer timeout, HookEntryStatus status, String statusReason, String filePath) {
}

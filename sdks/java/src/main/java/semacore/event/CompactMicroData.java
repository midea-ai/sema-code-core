// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

public record CompactMicroData(long clearedCount, long estimatedSavedTokens, long estimatedTokenAfter, boolean skippedFullCompact) {
}

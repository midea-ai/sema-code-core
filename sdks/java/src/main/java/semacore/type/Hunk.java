// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;

/** 行级 diff 的一个 hunk（与 npm diff 的 structuredPatch 输出同构）。 */
public record Hunk(long oldStart, long oldLines, long newStart, long newLines, List<String> lines) {
}

// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;

/**
 * 单文件 diff：会话基线 → 查询时磁盘内容。
 * status = ok 时带左右文本与 hunks；其它状态表示不可比较（见 {@link FileChangeStatus}）。
 */
public record FileDiffResult(
        String filePath,
        String displayPath,
        FileChangeState state,
        FileChangeStatus status,
        boolean baselineExists,
        Long additions,
        Long removals,
        Long line,
        Boolean rawChanged,
        boolean currentExists,
        String baselineText,
        String currentText,
        List<Hunk> hunks) {
}

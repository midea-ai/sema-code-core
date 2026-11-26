// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/**
 * 文件变更面板条目：本会话受控写入过的文件，按绝对路径去重、已过滤与基线一致的文件。
 * additions / removals / line 只在 status = ok 时有值。
 */
public record FileChangeItem(
        String filePath,
        String displayPath,
        FileChangeState state,
        FileChangeStatus status,
        boolean baselineExists,
        Long additions,
        Long removals,
        Long line,
        Boolean rawChanged) {
}

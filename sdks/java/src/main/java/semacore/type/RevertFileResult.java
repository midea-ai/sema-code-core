// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/** 「放弃修改」逐文件结果；失败时 error 说明原因（基线读不出来 / 超过捕获上限等）。 */
public record RevertFileResult(String filePath, String displayPath, RevertFileAction action, String error) {
}

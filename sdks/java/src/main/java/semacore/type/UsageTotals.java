// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/** 累计：sessions 为全部记录 sessionId 去重数，days 为有记录的日期数。 */
public record UsageTotals(long requests, UsageTokens tokens, long sessions, long days) {
}

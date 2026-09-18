// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/** hitKnown=服务商是否返回过缓存命中数；false 时 tokens.hit 恒为 0，miss 即总输入。 */
public record UsageModelStat(long requests, boolean hitKnown, UsageTokens tokens) {
}

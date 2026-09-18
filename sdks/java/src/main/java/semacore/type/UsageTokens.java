// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/** hit=缓存命中的输入 token，miss=未命中缓存的输入 token，output=输出 token。 */
public record UsageTokens(long hit, long miss, long output) {
}

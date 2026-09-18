// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/** lastAt=最近一次调用时间戳（毫秒）。 */
public record UsageSkillStat(long calls, long lastAt) {
}

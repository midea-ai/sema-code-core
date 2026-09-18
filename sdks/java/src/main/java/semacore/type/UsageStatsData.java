// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.Map;

/** getUsageStats 返回：since=最早记录日期 'YYYY-MM-DD'（无数据为 null），days 只含近 366 天且有记录的日期。 */
public record UsageStatsData(String since, long updatedAt, UsageTotals totals, Map<String, UsageDayData> days) {
}

// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

/** 单日聚合：models/tools/skills 按名称聚合，sessions 为当天去重后的会话 id。 */
public record UsageDayData(long requests, UsageTokens tokens, Map<String, UsageModelStat> models, Map<String, UsageToolStat> tools, Map<String, UsageSkillStat> skills, List<String> sessions) {
}

// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record CronTask(String id, String schedule, String task, boolean repeat, boolean persist, boolean status, long createdAt, String describeCronExpression, long activatedAt, List<Long> nextFireAt, String sessionId, String filePath, Long lastFiredAt) {
}

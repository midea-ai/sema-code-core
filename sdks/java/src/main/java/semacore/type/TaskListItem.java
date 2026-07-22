// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

public record TaskListItem(String taskId, String filepath, CronTaskStatus status, String type, String command, long startTime, Long pid, String agentType, Boolean foreground, Long endTime) {
}

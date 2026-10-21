// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

import semacore.type.GoalState;

/** goal:update 事件数据（≙ core GoalUpdateData）；reason 为 cleared 时 goal 为 null。 */
public record GoalUpdateData(GoalState goal, GoalUpdateReason reason) {
}

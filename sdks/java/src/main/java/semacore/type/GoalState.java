// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

/**
 * 长期目标（/goal）状态（≙ core GoalState）：getGoal 返回值与 goal:update 事件载荷。
 * round 起始为 1、仅自动续轮加一；maxRounds 因上限暂停后 resume 时累加；idleRounds 为连续无 tool_use 的目标轮数；
 * summary 为模型自报完成 / 受阻时给出的总结，可为 null。
 */
public record GoalState(String text, GoalStatus status, int round, int maxRounds, int idleRounds, String summary, long createdAt, long updatedAt) {
}

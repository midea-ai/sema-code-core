// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.event;

/**
 * goal:update 的原因（≙ core GoalUpdateData.reason）：
 * set/updated/round=设定 / 改文本 / 自动续轮；completed/blocked=模型自报；
 * cleared/resumed=接口触发（cleared 时 goal 为 null）；paused=用户暂停、中断或权限拒绝；
 * error/noProgress/maxRounds/mode=系统置 paused 的各自原因；status=裸 /goal 的回显，非状态变化。
 */
public enum GoalUpdateReason {
    set, updated, round,
    completed, blocked,
    cleared, resumed,
    paused, error, noProgress, maxRounds, mode,
    status
}

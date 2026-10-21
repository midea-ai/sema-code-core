// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.type;

/**
 * 长期目标状态（≙ core GoalStatus）：running=自主循环中；paused=用户暂停/中断、系统止损、重开会话，可 resume；
 * completed/blocked=模型自报，blocked 可 resume；不要了用 clearGoal 删除。
 */
public enum GoalStatus { running, paused, completed, blocked }

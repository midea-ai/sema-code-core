// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.type;

/** 历史思考回传策略：preserve=全部保留（默认）；current_turn=仅当前轮；omit=不回传 */
public enum ThinkingHistoryPolicy { preserve, current_turn, omit }

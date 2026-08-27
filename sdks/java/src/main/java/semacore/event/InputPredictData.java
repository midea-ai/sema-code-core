// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

/** input:predict —— 用户输入预测结果（需 enableInputPrediction 开启）；prediction 为空串表示"预计不回复"，UI 应清空提示。 */
public record InputPredictData(String prediction) {
}

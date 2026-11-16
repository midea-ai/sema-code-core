// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.event;

/** input:retracted —— 输入撤销（需 enableInputRetract 开启）：模型产出正文前用户主动中断，本条输入不进历史；与 session:interrupted 互斥，UI 应删掉该输入气泡并把原文放回输入框。 */
public record InputRetractedData(String inputId, String input, String originalInput) {
}

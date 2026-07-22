// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.event;

public sealed interface PickOptionQuestion permits RadioQuestion, CheckboxQuestion, SelectQuestion, TextQuestion, TextareaQuestion {
    String type();
    String id();
    String label();
}

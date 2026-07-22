// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.type;

public sealed interface ForkResult permits ForkResultOk, ForkResultErr {
    boolean ok();
}

// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。

package semacore.type;

import java.util.List;
import java.util.Map;

// code：稳定错误码（如历史密文解不开的 HISTORY_DECRYPT_FAILED），没有对应错误码时为 null。
// 注意 SDK 的 createSession 直接返回 SemaSession，失败抛 SemaBridgeException（code 在 .code() 上）
public record CreateSessionResultErr(boolean ok, String error, SemaErrorCode code) implements CreateSessionResult {
}

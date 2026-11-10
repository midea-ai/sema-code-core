// 由 sdks/shared 契约镜像生成的 DTO；字段名 = wire camelCase，与 sema-core / Python SDK 完全一致。
package semacore.type;

/**
 * 稳定错误码（≙ core SemaErrorCode）：桥 error 帧的 code，挂在 SemaBridgeException.code() 上；
 * 文案随 lang 变化而 code 不变。没有对应错误码的普通错误 code 为 null。
 */
public enum SemaErrorCode {
    /** 构造参数或运行期更新的配置校验不通过 */
    CONFIG_INVALID,
    /** 要写的域没有生效（scopes 未包含） */
    SCOPE_DISABLED,
    /** 要改的是宿主传入的 host 域条目 */
    HOST_READONLY,
    /** 历史文件是密文但没传密钥 */
    HISTORY_KEY_REQUIRED,
    /** 密钥不对或密文损坏 */
    HISTORY_DECRYPT_FAILED
}

package semacore.protocol;

/**
 * 桥返回 error 帧、或连接中断导致指令失败时抛出。
 * <p>
 * {@link #code()} 为 core 的稳定错误码（≙ semacore.type.SemaErrorCode：CONFIG_INVALID / SCOPE_DISABLED /
 * HOST_READONLY / HISTORY_KEY_REQUIRED / HISTORY_DECRYPT_FAILED），文案随 lang 变化而 code 不变；
 * 没有对应错误码（普通错误、连接中断）时为 null。
 */
public class SemaBridgeException extends RuntimeException {

    private final String action;
    private final String code;

    public SemaBridgeException(String action, String message) {
        this(action, message, null, null);
    }

    public SemaBridgeException(String action, String message, Throwable cause) {
        this(action, message, null, cause);
    }

    public SemaBridgeException(String action, String message, String code, Throwable cause) {
        super(action == null || action.isEmpty() ? message : "[" + action + "] " + message, cause);
        this.action = action;
        this.code = code == null || code.isEmpty() ? null : code;
    }

    /** 失败指令的 action 名；未知时为空字符串。 */
    public String action() {
        return action == null ? "" : action;
    }

    /** core 的稳定错误码；没有时为 null。 */
    public String code() {
        return code;
    }
}

namespace Semacore.Protocol;

/// <summary>
/// 桥返回 error 帧、或连接中断导致指令失败时抛出（≙ Java protocol/SemaBridgeException）。
/// <see cref="Code"/> 为 core 的稳定错误码（≙ Semacore.Types.SemaErrorCode：CONFIG_INVALID / SCOPE_DISABLED /
/// HOST_READONLY / HISTORY_KEY_REQUIRED / HISTORY_DECRYPT_FAILED），文案随 lang 变化而 code 不变；
/// 没有对应错误码（普通错误、连接中断）时为 null。
/// </summary>
public class SemaBridgeException : Exception
{
    private readonly string _action;

    public SemaBridgeException(string? action, string? message, Exception? cause = null)
        : this(action, message, null, cause)
    {
    }

    public SemaBridgeException(string? action, string? message, string? code, Exception? cause)
        : base(string.IsNullOrEmpty(action) ? message : $"[{action}] {message}", cause)
    {
        _action = action ?? "";
        Code = string.IsNullOrEmpty(code) ? null : code;
    }

    /// <summary>失败指令的 action 名；未知时为空字符串。</summary>
    public string Action => _action;

    /// <summary>core 的稳定错误码；没有时为 null。</summary>
    public string? Code { get; }
}

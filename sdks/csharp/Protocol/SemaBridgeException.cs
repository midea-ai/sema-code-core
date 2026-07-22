namespace Semacore.Protocol;

/// <summary>桥返回 error 帧、或连接中断导致指令失败时抛出（≙ Java protocol/SemaBridgeException）。</summary>
public class SemaBridgeException : Exception
{
    private readonly string _action;

    public SemaBridgeException(string? action, string? message, Exception? cause = null)
        : base(string.IsNullOrEmpty(action) ? message : $"[{action}] {message}", cause)
    {
        _action = action ?? "";
    }

    /// <summary>失败指令的 action 名；未知时为空字符串。</summary>
    public string Action => _action;
}

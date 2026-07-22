namespace Semacore.Transport;

/// <summary>
/// 桥推送的事件帧（BridgeEvent 的 SDK 公开形态，protobuf 类型不泄漏到公共 API；≙ Java transport/SemaEvent）。
/// </summary>
/// <param name="Event">事件名（响应类为 "ack" / "error"，其余为 sema-core 原始事件名）</param>
/// <param name="Data">JSON 序列化的数据（可为空字符串）</param>
/// <param name="CmdId">对应指令的 ID（仅响应类消息携带，否则为空字符串）</param>
/// <param name="SessionId">事件所属会话 ID（会话级事件携带，进程级事件为空字符串）</param>
public sealed record SemaEvent(string Event, string Data, string CmdId, string SessionId)
{
    /// <summary>是否为指令响应帧（ack / error，携带 CmdId）。</summary>
    public bool IsResponse => CmdId.Length > 0;
}

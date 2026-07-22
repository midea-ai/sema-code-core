namespace Semacore.Transport;

/// <summary><see cref="BridgeConnection"/> 的连接状态（≙ Java transport/ConnectionState）。</summary>
public enum ConnectionState
{
    /// <summary>首次建连中（含等待 sidecar 端口就绪）。</summary>
    Connecting,
    /// <summary>已连接，指令直发。</summary>
    Connected,
    /// <summary>流断开，正在按退避策略重连；期间指令进入缓冲队列。</summary>
    Reconnecting,
    /// <summary>已关闭（主动 Close、重连次数耗尽或端口解析失败），不再重连。</summary>
    Closed,
}

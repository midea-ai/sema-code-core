package semacore.transport;

/** {@link BridgeConnection} 的连接状态。 */
public enum ConnectionState {
    /** 首次建连中（含等待 sidecar 端口就绪）。 */
    CONNECTING,
    /** 已连接，指令直发。 */
    CONNECTED,
    /** 流断开，正在按退避策略重连；期间指令进入缓冲队列。 */
    RECONNECTING,
    /** 已关闭（主动 close、重连次数耗尽或端口解析失败），不再重连。 */
    CLOSED,
}

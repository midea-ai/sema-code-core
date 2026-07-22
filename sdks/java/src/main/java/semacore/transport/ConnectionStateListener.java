package semacore.transport;

/** 连接状态变化监听器。 */
@FunctionalInterface
public interface ConnectionStateListener {

    /**
     * @param state 新状态
     * @param error 触发状态变化的异常（如流断开原因）；正常变化为 null
     */
    void onStateChange(ConnectionState state, Throwable error);
}

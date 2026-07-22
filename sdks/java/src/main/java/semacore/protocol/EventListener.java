package semacore.protocol;

/** 桥事件监听器（协议层：已按事件名 / 会话过滤）。 */
@FunctionalInterface
public interface EventListener {

    /**
     * @param dataJson  事件 data（JSON 字符串，可为空字符串）
     * @param sessionId 事件所属会话 ID（进程级事件为空字符串）
     */
    void onEvent(String dataJson, String sessionId);
}

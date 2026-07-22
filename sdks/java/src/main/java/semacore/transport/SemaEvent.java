package semacore.transport;

/**
 * 桥推送的事件帧（BridgeEvent 的 SDK 公开形态，protobuf 类型不泄漏到公共 API）。
 *
 * @param event     事件名（响应类为 "ack" / "error"，其余为 sema-core 原始事件名）
 * @param data      JSON 序列化的数据（可为空字符串）
 * @param cmdId     对应指令的 ID（仅响应类消息携带，否则为空字符串）
 * @param sessionId 事件所属会话 ID（会话级事件携带，进程级事件为空字符串）
 */
public record SemaEvent(String event, String data, String cmdId, String sessionId) {

    /** 是否为指令响应帧（ack / error，携带 cmdId）。 */
    public boolean isResponse() {
        return !cmdId.isEmpty();
    }
}

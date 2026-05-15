// ── 宿主 → Node.js（指令帧）──────────────────────────────────────

export interface BridgeCommand {
    id: string;           // 请求 ID，用于匹配响应
    action: string;
    payload?: any;
}

// ── Node.js → 宿主（事件帧）──────────────────────────────────────

export interface BridgeEvent {
    event: string;
    data?: any;
    cmdId?: string;       // 对应指令的 ID（仅响应类消息携带）
}

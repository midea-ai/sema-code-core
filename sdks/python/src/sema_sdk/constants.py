"""镜像 sema-core 导出的常量（≙ Java api/SemaConstants）。

新增常量须与 core 侧导出保持同名同值（一致性由 bridge 的 manifest 校验兜底）。
"""

# 主代理 agentId（core: src/manager/StateManager.ts）。message:complete 等事件按此区分主/子代理。
MAIN_AGENT_ID = "main"

# 桥协议版本：init ack 携带 protocolVersion，SemaCore.attach 校验相等，不等即快速失败。
PROTOCOL_VERSION = 1

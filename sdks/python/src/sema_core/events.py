"""事件名常量（镜像 Java api/SemaEvents；名与值 = core 原始事件名，不做任何转换）。

一致性由 bridge 的 manifest 校验兜底（sdks/shared/bridge/scripts/check-consistency.mjs）。
"""

# ── 会话级 ────────────────────────────────────────────────────────────────
SESSION_READY = "session:ready"
SESSION_ERROR = "session:error"
SESSION_INTERRUPTED = "session:interrupted"
SESSION_CLEARED = "session:cleared"
STATE_UPDATE = "state:update"
INPUT_RECEIVED = "input:received"
INPUT_PROCESSING = "input:processing"
MESSAGE_TEXT_CHUNK = "message:text:chunk"
MESSAGE_THINKING_CHUNK = "message:thinking:chunk"
MESSAGE_COMPLETE = "message:complete"
TOOL_PERMISSION_REQUEST = "tool:permission:request"
TOOL_PERMISSION_AUTO = "tool:permission:auto"
TOOL_EXECUTION_COMPLETE = "tool:execution:complete"
TOOL_EXECUTION_CHUNK = "tool:execution:chunk"
TOOL_EXECUTION_ERROR = "tool:execution:error"
TASK_AGENT_START = "task:agent:start"
TASK_AGENT_END = "task:agent:end"
TASK_START = "task:start"
TASK_END = "task:end"
TASK_TRANSFER = "task:transfer"
TODOS_UPDATE = "todos:update"
TOPIC_UPDATE = "topic:update"
PICK_OPTION_REQUEST = "pick:option:request"
PLAN_EXIT_REQUEST = "plan:exit:request"
PLAN_IMPLEMENT = "plan:implement"
COMPACT_EXEC = "compact:exec"
COMPACT_MICRO = "compact:micro"
CONVERSATION_USAGE = "conversation:usage"
FILE_REFERENCE = "file:reference"
PERMISSION_LEVEL_UPDATE = "permissionLevel:update"
QUICKCHAT_RESPONSE = "quickchat:response"
HOOK_NOTICE = "hook:notice"

# ── 进程级 ────────────────────────────────────────────────────────────────
CRON_UPDATE = "cron:update"
MCP_SERVER_STATUS = "mcp:server:status"

# ── 桥合成 ────────────────────────────────────────────────────────────────
MODEL_UPDATE = "model:update"
TASK_WATCH_DELTA = "task:watch:delta"

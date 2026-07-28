"""类型化 DTO —— 事件数据（镜像 sema-core 的 src/events/types.ts）。

对齐 Node：`from sema_core.event import TextChunkData, ...` ≙ `from 'sema-core/event'`。

事件回调收到的 data 即这些 TypedDict（运行时为普通 dict）；订阅时可标注参数类型
获得补全，如 `session.on("message:text:chunk", lambda d: ...)  # d: TextChunkData`。
事件名常量见 events.py（`from sema_core import SemaEvents`）。
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional, TypedDict, Union

# 跨模块复用 types 里的基础/共享类型（event 依赖 types，反向不依赖，分层清晰）
from .types import (
    AppSessionState,
    CronTaskStatus,
    FileReferenceInfo,
    InputImageAttachment,
    MCPServerInfo,
    ModelUpdateData,
    PermissionLevel,
    TodoItem,
)

if TYPE_CHECKING:
    from typing_extensions import NotRequired


# ==================== 用量 ====================

class Usage(TypedDict):
    # 定义在事件模块（Node 亦从 'sema-core/event' 导出 Usage）
    useTokens: int
    maxTokens: int
    promptTokens: int


# ==================== 会话生命周期 / 状态 ====================

class SessionReadyData(TypedDict):
    pid: int
    workingDir: str
    sessionId: str
    historyLoaded: bool
    usage: Usage
    projectInputHistory: List[str]
    todos: List[TodoItem]
    readFileTimestamps: Dict[str, int]


class SessionInterruptedData(TypedDict):
    agentId: str
    content: str


class SessionErrorDetail(TypedDict):
    code: str
    message: str
    details: NotRequired[Any]  # 不透明


class SessionErrorData(TypedDict):
    type: Literal["api_error", "fatal_error", "context_length_exceeded", "model_error"]
    error: SessionErrorDetail


class SessionClearedData(TypedDict):
    sessionId: Optional[str]


class StateUpdateData(TypedDict):
    state: AppSessionState


# ==================== 用户输入 ====================

class InputReceivedData(TypedDict):
    inputId: str
    input: str
    queued: bool
    queueLength: int
    originalInput: NotRequired[str]


class InputProcessingData(TypedDict):
    inputId: str
    input: str
    originalInput: NotRequired[str]
    attachments: NotRequired[List[InputImageAttachment]]


# ==================== AI 消息 ====================

class ThinkingChunkData(TypedDict):
    id: str
    delta: str


class TextChunkData(TypedDict):
    id: str
    delta: str


class MessageToolCall(TypedDict):
    name: str


class MessageCompleteData(TypedDict):
    id: str
    agentId: str
    reasoning: str
    content: str
    hasToolCalls: bool
    toolCalls: NotRequired[List[MessageToolCall]]


# ==================== 工具 ====================

class ToolPermissionRequestData(TypedDict):
    agentId: str
    toolId: str
    toolName: str
    title: str
    content: Union[str, Dict[str, Any]]  # string 或 JSON 对象 → 不透明兜底
    options: Dict[str, str]


class ToolExecutionCompleteData(TypedDict):
    agentId: str
    toolId: str
    toolName: str
    title: str
    summary: str
    content: Union[str, Dict[str, Any]]


# tool:execution:chunk 结构同 complete（content 只传 delta）
ToolExecutionChunkData = ToolExecutionCompleteData


class ToolExecutionErrorData(TypedDict):
    agentId: str
    toolName: str
    title: str
    content: str
    toolId: NotRequired[str]
    input: NotRequired[Dict[str, Any]]


class ToolPermissionAutoData(TypedDict):
    agentId: str
    toolId: str
    toolName: str
    content: str


# ==================== 交互应答（session.respond_* 入参）====================

class ToolPermissionResponse(TypedDict):
    toolId: str
    toolName: str
    selected: str


class PickOptionResponseData(TypedDict):
    agentId: str
    answers: Optional[str]


class PlanExitResponseData(TypedDict):
    agentId: str
    selected: Literal["startEditing", "clearContextAndStart"]


# ==================== 待办 / 权限 / 主题 / 用量 ====================

TodosUpdateData = List[TodoItem]


class PermissionLevelUpdateData(TypedDict):
    level: PermissionLevel


class TopicUpdateData(TypedDict):
    isNewTopic: bool
    title: str


class ConversationUsageData(TypedDict):
    usage: Usage


class CompactExecData(TypedDict):
    tokenBefore: int
    tokenCompact: int
    compactRate: float
    errMsg: NotRequired[str]
    mode: NotRequired[Literal["summary", "truncated", "failed"]]
    reason: NotRequired[str]


class CompactMicroData(TypedDict):
    clearedCount: int
    estimatedSavedTokens: int
    estimatedTokenAfter: int
    skippedFullCompact: bool


class FileReferenceData(TypedDict):
    references: List[FileReferenceInfo]


# ==================== 问答（tagged 联合）====================

class RadioQuestion(TypedDict):
    type: Literal["radio"]
    id: str
    label: str
    options: List[str]
    required: NotRequired[bool]


class CheckboxQuestion(TypedDict):
    type: Literal["checkbox"]
    id: str
    label: str
    options: List[str]
    required: NotRequired[bool]
    maxSelections: NotRequired[int]


class SelectQuestion(TypedDict):
    type: Literal["select"]
    id: str
    label: str
    options: List[str]
    required: NotRequired[bool]


class TextQuestion(TypedDict):
    type: Literal["text"]
    id: str
    label: str
    required: NotRequired[bool]
    placeholder: NotRequired[str]


class TextareaQuestion(TypedDict):
    type: Literal["textarea"]
    id: str
    label: str
    required: NotRequired[bool]
    placeholder: NotRequired[str]


# 按 type 判别；类型检查器可据 d["type"] 收窄到具体变体
PickOptionQuestion = Union[
    RadioQuestion, CheckboxQuestion, SelectQuestion, TextQuestion, TextareaQuestion
]


class PickOptionRequestData(TypedDict):
    agentId: str
    questions: List[PickOptionQuestion]
    estimatedTime: NotRequired[str]
    intro: NotRequired[str]


# ==================== Plan 模式 ====================

class PlanExitRequestOptions(TypedDict):
    startEditing: str
    clearContextAndStart: str


class PlanExitRequestData(TypedDict):
    agentId: str
    planFilePath: str
    planContent: str
    options: PlanExitRequestOptions


class PlanImplementData(TypedDict):
    planFilePath: str
    planContent: str


# ==================== 子代理 / 后台任务 ====================

class TaskAgentStartData(TypedDict):
    taskId: str
    agent_type: str
    title: str
    instructions: str
    background: bool


class TaskAgentEndData(TypedDict):
    taskId: str
    status: Literal["completed", "failed", "interrupted"]
    content: str


class TaskStartData(TypedDict):
    taskId: str
    command: str
    filepath: str
    status: CronTaskStatus
    type: Literal["RunShell", "SubAgent"]
    pid: NotRequired[int]
    agentType: NotRequired[str]


class TaskEndData(TypedDict):
    taskId: str
    status: Literal["completed", "failed", "killed"]
    summary: str


# task:transfer 数据格式同 task:start
TaskTransferData = TaskStartData


# ==================== quickchat / cron / 桥合成 ====================

class QuickchatResponseData(TypedDict):
    question: str
    content: str


# core 导出名为小写 quickchatResponseData，提供同名别名对齐 Node
quickchatResponseData = QuickchatResponseData


class CronUpdateData(TypedDict):
    pass  # 空对象


# 进程级事件名（≙ core ProcessEvent）；应通过 SemaCore.on 订阅
ProcessEvent = Literal["cron:update", "mcp:server:status"]


# mcp:server:status 数据 = MCPServerInfo
MCPServerStatusData = MCPServerInfo


# model:update 合成事件数据 = ModelUpdateData
ModelUpdateEventData = ModelUpdateData


class TaskWatchDeltaData(TypedDict):
    """task:watch:delta 合成事件（watchTask 增量）。"""
    taskId: str
    delta: str

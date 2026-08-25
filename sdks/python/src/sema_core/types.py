"""类型化 DTO —— 配置 / 参数 / 返回值（镜像 sema-core 的 src/types）。

对齐 Node：`from sema_core.types import ModelConfig, ...` ≙ `from 'sema-core/types'`。

设计：全部 TypedDict —— 键即 wire 上的 camelCase 字段名（与 core 一字不差、不转
snake_case），运行时就是普通 dict，零序列化层、零运行时开销；只为 api 层方法签名
提供静态类型与补全。字面量联合用 Literal，判别联合用 Literal 判别字段 + Union。
不透明兜底：core 的 any / Record<string,any> / string|object → dict 或 object。

手动维护约束：core 改公开签名时同步改这里（与 Java model、C# Model 三处镜像）；
名字级漂移由 shared/bridge/scripts/check-consistency.mjs 兜底，字段级靠手写纪律。
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, List, Literal, Optional, TypedDict, Union

# 常量随 types 一并可从此处导入（对齐 Node: `MAIN_AGENT_ID` from 'sema-core/types'）
from .constants import MAIN_AGENT_ID  # noqa: F401

if TYPE_CHECKING:
    # NotRequired 仅供类型检查器；配合 from __future__ import annotations，运行时不求值、
    # 无需 typing_extensions 运行时依赖，Python 3.10 亦可（TypedDict 运行时只按 total 处理）。
    from typing_extensions import NotRequired


# ==================== 字面量枚举 ====================

AgentMode = Literal["Agent", "Plan", "Design"]
SystemPromptMode = Literal["append", "replace", "replaceAll"]
PermissionLevel = Literal["Ask", "AutoEdit", "AutoRun", "Bypass"]
AdapterType = Literal["openai", "anthropic"]
MCPTransportType = Literal["stdio", "sse", "http"]
MCPScopeType = Literal["local", "project", "user", "plugin"]
MCPServerStatus = Literal["disconnected", "connecting", "connected", "error"]
PluginScopeKind = Literal["local", "project", "user"]
AgentScope = Literal["user", "project", "builtin", "plugin"]
SkillScope = Literal["user", "project", "plugin"]
CommandScope = Literal["user", "project", "plugin"]
RuleScope = Literal["user", "project"]
HookScope = Literal["user", "project"]
HookEntryStatus = Literal["ok", "skipped", "invalid"]
ToolStatus = Literal["enable", "disable"]
CronTaskStatus = Literal["running", "completed", "failed", "killed"]  # 后台任务状态（core: task.ts / events）
TodoTaskStatus = Literal["pending", "in_progress", "completed"]
ForkFileEffect = Literal["modify", "recreate", "delete"]
AppSessionState = Literal["idle", "processing"]

# 支持动态更新的核心配置字段名（≙ core UpdatableCoreConfigKeys）
UpdatableCoreConfigKeys = Literal[
    "stream", "thinking", "systemPrompt", "customRules", "skipFileEditPermission",
    "skipShellExecPermission", "skipSkillPermission", "skipMCPToolPermission",
    "skipFetchUrlPermission", "skipExternalFileReadPermission", "enableLLMCache",
    "disableBackgroundTasks", "enableToolSearch",
]


# ==================== 配置 / 模型 ====================

class SemaCoreConfig(TypedDict, total=False):
    """SemaCore 构造配置（init payload）；全字段可选。"""
    workingDir: str
    logLevel: Literal["debug", "info", "warn", "error", "none"]
    stream: bool
    thinking: bool
    systemPrompt: str
    systemPromptMode: SystemPromptMode
    customRules: str
    skipFileEditPermission: bool
    skipShellExecPermission: bool
    skipSkillPermission: bool
    skipMCPToolPermission: bool
    skipFetchUrlPermission: bool
    skipExternalFileReadPermission: bool
    enableLLMCache: bool
    useTools: Optional[List[str]]
    disabledTools: Optional[List[str]]
    agentMode: AgentMode
    disableTopicDetection: bool
    disableBackgroundTasks: bool
    enableToolSearch: bool
    toolSearchDefaultTools: Optional[List[str]]
    maxSessions: int


class UpdatableCoreConfig(TypedDict, total=False):
    """updateCoreConfig 可动态更新的核心配置子集（≙ core UpdatableCoreConfig）。"""
    stream: bool
    thinking: bool
    systemPrompt: str
    customRules: str
    skipFileEditPermission: bool
    skipShellExecPermission: bool
    skipSkillPermission: bool
    skipMCPToolPermission: bool
    skipFetchUrlPermission: bool
    skipExternalFileReadPermission: bool
    enableLLMCache: bool
    disableBackgroundTasks: bool
    enableToolSearch: bool


class ModelConfig(TypedDict):
    provider: str
    modelName: str
    baseURL: str
    apiKey: str
    maxTokens: int
    contextLength: int
    adapt: AdapterType


class TaskConfig(TypedDict):
    """applyTaskModel 参数：主/快模型指针。"""
    main: str
    quick: str


class ModelInfo(TypedDict):
    id: str
    name: str
    ownedBy: NotRequired[str]
    key_doc_url: NotRequired[str]


class FetchModelsParams(TypedDict):
    baseURL: str
    apiKey: str
    adapt: AdapterType
    provider: NotRequired[str]
    modelsUrl: NotRequired[str]


class FetchModelsResult(TypedDict):
    success: bool
    models: NotRequired[List[ModelInfo]]
    message: NotRequired[str]
    curlCommand: NotRequired[str]


class ApiTestParams(TypedDict):
    baseURL: str
    apiKey: str
    modelName: str
    adapt: AdapterType
    provider: NotRequired[str]


class ApiTestResult(TypedDict):
    success: bool
    message: str
    curlCommand: NotRequired[str]


class ModelUpdateData(TypedDict):
    """addModel/delModel/switchModel/applyTaskModel/getModelData 返回；亦为 model:update 合成事件数据。"""
    modelName: str
    modelList: List[str]
    taskConfig: TaskConfig


class ToolInfo(TypedDict):
    name: str
    description: str
    status: ToolStatus


class FileReferenceInfo(TypedDict):
    """文件引用信息（core types 导出；file:reference 事件的 references 项与此同构）。"""
    type: Literal["file", "dir"]
    name: str
    content: str


# ==================== MCP ====================

class MCPServerConfig(TypedDict):
    name: str
    transport: MCPTransportType
    scope: MCPScopeType
    description: NotRequired[str]
    enabled: NotRequired[bool]
    useTools: NotRequired[Optional[List[str]]]
    command: NotRequired[str]
    args: NotRequired[List[str]]
    env: NotRequired[Dict[str, str]]
    url: NotRequired[str]
    headers: NotRequired[Dict[str, str]]


class MCPToolDefinitionParams(TypedDict):
    type: Literal["object"]
    # properties 为 JSON Schema，本就动态 → 不透明
    properties: NotRequired[Dict[str, Any]]
    required: NotRequired[List[str]]


class MCPToolDefinition(TypedDict):
    name: str
    toolParams: MCPToolDefinitionParams
    description: NotRequired[str]


class MCPServerCapabilities(TypedDict, total=False):
    tools: List[MCPToolDefinition]


class MCPServerInfo(TypedDict):
    """getMCPServerInfo 等返回项；亦为 mcp:server:status 事件数据。"""
    config: MCPServerConfig
    connectStatus: MCPServerStatus
    status: bool
    capabilities: NotRequired[MCPServerCapabilities]
    connectedAt: NotRequired[int]
    error: NotRequired[str]
    scope: NotRequired[MCPScopeType]
    filePath: NotRequired[str]


# ==================== Agents / Skills / Commands ====================

class AgentConfig(TypedDict):
    name: str
    description: str
    tools: Union[List[str], Literal["*"]]  # 默认 "*"
    model: str
    prompt: str
    locate: NotRequired[AgentScope]
    filePath: NotRequired[str]


class SkillConfig(TypedDict):
    name: str
    description: str
    prompt: str
    locate: NotRequired[SkillScope]
    filePath: NotRequired[str]


class CommandConfig(TypedDict):
    name: str
    description: str
    prompt: str
    argumentHint: NotRequired[Union[str, List[str]]]
    locate: NotRequired[CommandScope]
    filePath: NotRequired[str]


# ==================== Memory / Rule / Design ====================

# 含保留字 `from` 字段，用函数式 TypedDict 语法；prompt 实为必填，此处整体 total=False。
MemoryConfig = TypedDict("MemoryConfig", {
    "prompt": str,
    "from": str,
    "FilePath": str,
    "refFilePath": "List[str]",
}, total=False)

RuleConfig = TypedDict("RuleConfig", {
    "prompt": str,
    "locate": "RuleScope",
    "from": str,
    "filePath": str,
}, total=False)


# ==================== Hooks ====================

class HookParseError(TypedDict):
    source: HookScope
    message: str


class HookEntryInfo(TypedDict):
    event: str
    source: HookScope
    matcher: NotRequired[str]
    command: str
    timeout: NotRequired[int]  # 配置原值（秒），未配则缺省（运行时默认 60s）
    status: HookEntryStatus
    statusReason: NotRequired[str]
    filePath: NotRequired[str]  # "绝对路径:起始行-结束行"（事件块粒度）


class HooksInfo(TypedDict):
    userConfigPath: str
    projectConfigPath: str
    userConfigExists: bool
    projectConfigExists: bool
    parseErrors: List[HookParseError]
    events: Dict[str, List[HookEntryInfo]]  # 按事件分组，用户级在前、项目级追加


class DesignSystemColor(TypedDict):
    key: str
    value: str


class DesignSkillInfo(TypedDict):
    folderName: str
    filePath: str
    name: str
    description: str


class DesignSystemInfo(TypedDict):
    folderName: str
    filePath: str
    name: str
    description: str
    swatches: List[DesignSystemColor]
    colors: List[DesignSystemColor]


# ==================== 插件市场 ====================

class PluginComponentEntry(TypedDict):
    name: str
    filePath: str


class PluginComponents(TypedDict):
    commands: List[PluginComponentEntry]
    agents: List[PluginComponentEntry]
    skills: List[PluginComponentEntry]
    mcp: List[PluginComponentEntry]


class MarketplaceSource(TypedDict):
    source: str
    repo: NotRequired[str]
    path: NotRequired[str]


class MarketplaceAvailableItem(TypedDict):
    name: str
    description: str
    author: str


class MarketplaceInfoResult(TypedDict):
    name: str
    source: MarketplaceSource
    lastUpdated: str
    available: List[MarketplaceAvailableItem]
    installed: List[str]


class PluginInfoResult(TypedDict):
    name: str
    marketplace: str
    scope: PluginScopeKind
    status: bool
    version: str
    description: str
    author: str
    components: PluginComponents


class MarketplacePluginsInfo(TypedDict):
    marketplaces: List[MarketplaceInfoResult]
    plugins: List[PluginInfoResult]


# ==================== Cron ====================

class CronTask(TypedDict):
    id: str
    schedule: str
    task: str
    title: NotRequired[str]  # 短标题（创建时生成，≤30 字符）；旧任务可能缺失，UI 回退显示任务 id
    repeat: bool
    persist: bool
    status: bool
    createdAt: int
    describeCronExpression: str
    activatedAt: int
    nextFireAt: List[int]
    sessionId: NotRequired[str]
    filePath: NotRequired[str]
    lastFiredAt: NotRequired[int]


class CronTaskFileEntry(TypedDict):
    """CronTaskFile.tasks 项：core 用 Pick<CronTask, ...> 的持久化子集。"""
    id: str
    schedule: str
    task: str
    title: NotRequired[str]  # 旧文件可能缺失
    repeat: bool
    createdAt: int
    lastFiredAt: NotRequired[int]


class CronTaskFile(TypedDict):
    """cron 持久化文件格式（仅核心字段，运行时字段加载时生成）。"""
    tasks: List[CronTaskFileEntry]


# ==================== 待办（会话 ready / todos 事件共用）====================

class TodoItem(TypedDict):
    """UI 层待办展示（精简，事件推送用）。"""
    id: str
    title: str
    status: TodoTaskStatus
    progressText: str


class TodoTask(TypedDict):
    """完整任务数据（存储 / LLM 交互用）。"""
    id: str
    title: str
    description: str
    status: TodoTaskStatus
    blocks: List[str]
    blockedBy: List[str]
    createdAt: int
    updatedAt: int
    progressText: NotRequired[str]


# ==================== 输入附件（processUserInput 参数）====================

class InputImageAttachment(TypedDict):
    type: Literal["image"]
    data: str  # base64，不含 data: 前缀
    media_type: Literal["image/jpeg", "image/png", "image/gif", "image/webp"]


# ==================== 会话创建 / Fork / 任务 ====================

class CreateSessionOptions(TypedDict, total=False):
    sessionId: str
    agentMode: AgentMode
    permissionLevel: PermissionLevel
    # 会话级模型覆盖（profile 名，同 switch_model 参数），仅本会话生效、不持久化；不传沿用全局配置
    mainModel: str
    quickModel: str


class CreateSessionResultOk(TypedDict):
    ok: Literal[True]
    session: Any  # SemaSession（避免与 api 层循环依赖，此处留 Any）


class CreateSessionResultErr(TypedDict):
    ok: Literal[False]
    error: str


# ≙ core CreateSessionResult；注意 SDK 的 create_session 直接返回 SemaSession（已解包）。
CreateSessionResult = Union[CreateSessionResultOk, CreateSessionResultErr]


class ForkOptions(TypedDict, total=False):
    restoreFiles: bool


class ForkFileChange(TypedDict):
    filePath: str
    displayPath: str
    effect: ForkFileEffect
    additions: int
    removals: int
    binary: NotRequired[bool]


class ForkPreview(TypedDict):
    messageUuid: str
    canRestoreFiles: bool
    files: List[ForkFileChange]


class ForkResultOk(TypedDict):
    ok: Literal[True]
    sessionId: str
    restoredFiles: List[str]


class ForkResultErr(TypedDict):
    ok: Literal[False]
    error: str


ForkResult = Union[ForkResultOk, ForkResultErr]


class BranchResultOk(TypedDict):
    ok: Literal[True]
    sessionId: str


class BranchResultErr(TypedDict):
    ok: Literal[False]
    error: str


# ≙ core BranchResult（分支到新聊天：新会话历史 = 原历史截到锚点用户输入之前，不传锚点则全量复制）
BranchResult = Union[BranchResultOk, BranchResultErr]


class TaskListItem(TypedDict):
    taskId: str
    filepath: str
    status: CronTaskStatus
    type: str
    command: str
    startTime: int
    pid: NotRequired[int]
    agentType: NotRequired[str]
    foreground: NotRequired[bool]
    endTime: NotRequired[int]


# ==================== 桥 ack 改形（wire 形状 ≠ core 签名）====================

class InitAck(TypedDict):
    ready: bool
    protocolVersion: int


class SessionIdAck(TypedDict):
    sessionId: str

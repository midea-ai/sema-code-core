"""类型化 DTO —— 配置 / 参数 / 返回值（镜像 sema-core 的 src/types）。

对齐 Node：`from sema_core.types import ModelConfig, ...` ≙ `from 'sema-core/types'`。

设计：全部 TypedDict —— 键即 wire 上的 camelCase 字段名（与 core 一字不差、不转
snake_case），运行时就是普通 dict，零序列化层、零运行时开销；只为 api 层方法签名
提供静态类型与补全。字面量联合用 Literal，判别联合用 Literal 判别字段 + Union。
不透明兜底：core 的 any / Record<string,any> / string|object → dict 或 object。

手动维护约束：core 改公开签名时同步改这里（与 Java model、C# Model 三处镜像），
名字级与字段级均靠手写纪律，以 shared/bridge/manifest/actions.json 为契约基准。
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
# 历史思考回传策略：preserve=全部保留（默认）；current_turn=仅当前轮；omit=不回传
ThinkingHistoryPolicy = Literal["preserve", "current_turn", "omit"]
MCPTransportType = Literal["stdio", "sse", "http"]
# host：宿主构造时传入的条目（只读、同名优先）；MCP 的 host 条目 env / headers 值对外打码
MCPScopeType = Literal["host", "local", "project", "user", "plugin"]
MCPServerStatus = Literal["disconnected", "connecting", "connected", "error"]
PluginScopeKind = Literal["local", "project", "user"]
AgentScope = Literal["host", "user", "project", "builtin", "plugin"]
SkillScope = Literal["host", "user", "project", "plugin", "builtin"]
CommandScope = Literal["host", "user", "project", "plugin"]
RuleScope = Literal["user", "project"]
HookScope = Literal["host", "user", "project", "plugin"]
# 稳定错误码（≙ core SemaErrorCode）：SemaBridgeException.code / create_session 失败的 code
SemaErrorCode = Literal[
    "CONFIG_INVALID",          # 构造参数或运行期更新的配置校验不通过
    "SCOPE_DISABLED",          # 要写的域没有生效（scopes 未包含）
    "HOST_READONLY",           # 要改的是宿主传入的 host 域条目
    "HISTORY_KEY_REQUIRED",    # 历史文件是密文但没传密钥
    "HISTORY_DECRYPT_FAILED",  # 密钥不对或密文损坏
]
HookEntryStatus = Literal["ok", "skipped", "invalid"]
ToolStatus = Literal["enable", "disable"]
CronTaskStatus = Literal["running", "completed", "failed", "killed"]  # 后台任务状态（core: task.ts / events）
TodoTaskStatus = Literal["pending", "in_progress", "completed"]
ForkFileEffect = Literal["modify", "recreate", "delete"]
AppSessionState = Literal["idle", "processing"]

# 支持动态更新的核心配置字段名（≙ core UpdatableCoreConfigKeys）
UpdatableCoreConfigKeys = Literal[
    "lang", "stream", "thinking", "systemPrompt", "customRules", "skipFileEditPermission",
    "skipShellExecPermission", "skipSkillPermission", "skipMCPToolPermission",
    "skipFetchUrlPermission", "fetchUrlBrowserUserAgent", "skipExternalFileReadPermission",
    "disableBackgroundTasks", "enableToolSearch", "enableInputPrediction",
    "disableLLMLog", "disableEventLog",
]


# ==================== host 域内容 / 生效域 / 持久化保护（≙ core types/host.ts） ====================
# 宿主在构造参数里传入的模型 / MCP / hook / skill / 子代理 / 命令叫 host 域：只读、同名盖掉其他域、不落盘；
# scopes 指定每一类哪些域生效，不写 = 全部生效。均只在构造时生效。

class ModelsInput(TypedDict):
    """宿主内置的模型列表与指针（字段同 add_model / add_image_model 入参）。"""
    profiles: List["ModelConfig"]
    imageProfiles: NotRequired[List["ImageModelConfig"]]
    main: NotRequired[str]   # 主模型 "modelName[provider]"，缺省取 profiles[0]；是没有用户选择时的缺省值
    quick: NotRequired[str]  # 快速模型，缺省同 main
    image: NotRequired[str]  # 文生图模型，缺省取 imageProfiles[0]，传 "" 停用文生图


class MCPServerInput(TypedDict):
    """宿主内置的 MCP 服务（字段同 add_mcp_server 入参，去掉 scope）；查询接口与状态事件里 env / headers 值打码。"""
    name: str
    transport: MCPTransportType
    description: NotRequired[str]
    command: NotRequired[str]
    args: NotRequired[List[str]]
    env: NotRequired[Dict[str, str]]
    url: NotRequired[str]
    headers: NotRequired[Dict[str, str]]
    enabled: NotRequired[bool]  # 默认 True；不受 settings 的 disabledMcpServers 影响
    useTools: NotRequired[Optional[List[str]]]  # 允许的工具名，None / 缺省表示全部


class HookCommandInput(TypedDict):
    type: NotRequired[Literal["command"]]
    command: str
    timeout: NotRequired[int]
    failClosed: NotRequired[bool]


class HookGroupInput(TypedDict):
    matcher: NotRequired[str]
    hooks: List[HookCommandInput]


# 宿主内置的 hook：即 hooks.json 里 hooks 字段的内容，键为事件名
HooksInput = Dict[str, List[HookGroupInput]]


class SkillInput(TypedDict):
    """内联 skill：正文与文本子文件只在内存里，磁盘上不留。"""
    name: str
    description: str
    prompt: str  # SKILL.md 正文
    files: NotRequired[Dict[str, str]]  # 文本子文件：相对路径 → 内容，模型用 skill 工具的 file 参数读
    resourceDir: NotRequired[str]  # 脚本、图片、模板等所在的磁盘目录（绝对路径），不保护


class SkillsInput(TypedDict, total=False):
    items: List[SkillInput]  # 内联 skill
    dirs: List[str]  # 产品自带的明文目录，每个目录下是 <skill 名>/SKILL.md


class AgentInput(TypedDict):
    """内联子代理（字段同 add_agent_conf 入参，去掉 locate）。"""
    name: str
    description: str
    prompt: str
    tools: NotRequired[Union[List[str], Literal["*"]]]  # 默认 "*"
    model: NotRequired[str]  # "quick" 对应快速模型，其他值均对应主模型


class AgentsInput(TypedDict, total=False):
    items: List[AgentInput]
    dirs: List[str]  # 产品自带的明文目录，每个目录下是 <name>.md


class CommandInput(TypedDict):
    """内联命令（字段同 add_command_conf 入参，去掉 locate）。"""
    name: str
    description: str
    prompt: str
    argumentHint: NotRequired[Union[str, List[str]]]


class CommandsInput(TypedDict, total=False):
    items: List[CommandInput]
    dirs: List[str]  # 产品自带的明文目录，每个目录下是 <name>.md，子目录成为 dir:name


class ScopesConfig(TypedDict, total=False):
    """各类生效的域；不写 = 该类全部域生效，要锁定必须显式写。"""
    models: List[Literal["host", "user"]]
    mcp: List[Literal["host", "user", "project"]]
    hooks: List[Literal["host", "user", "project"]]
    skills: List[Literal["host", "builtin", "user", "project"]]
    agents: List[Literal["host", "builtin", "user", "project"]]
    commands: List[Literal["host", "user", "project"]]
    plugins: List[PluginScopeKind]  # 插件没有 host 域，值是安装位置；[] 表示不加载任何插件


class EncryptionConfig(TypedDict):
    """会话历史、hook 会话记录、快照加密；密钥只在内存。"""
    key: str  # 32 字节随机密钥的 base64（44 个字符）
    keyId: NotRequired[str]  # 可选的密钥标识，写进密文开头


# ==================== 配置 / 模型 ====================

class SemaCoreConfig(TypedDict, total=False):
    """SemaCore 构造配置（init payload）；全字段可选。"""
    workingDir: str
    logLevel: Literal["debug", "info", "warn", "error", "none"]
    lang: Literal["zh", "en", "de", "fr", "it"]
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
    fetchUrlBrowserUserAgent: bool
    skipExternalFileReadPermission: bool
    useTools: Optional[List[str]]
    disabledTools: Optional[List[str]]
    agentMode: AgentMode
    disableTopicDetection: bool
    enableInputPrediction: bool  # 一轮结束后用 quick 模型预测用户下一句（事件 input:predict），默认否
    disableBackgroundTasks: bool
    disableMemory: bool  # 关闭内置记忆（不拼记忆提示词、不注入 MEMORY.md、不读 .sema/memory、记忆文件编辑豁免失效），仅构造时生效
    enableToolSearch: bool
    toolSearchDefaultTools: Optional[List[str]]
    maxSessions: int
    usageProduct: str  # 使用统计的产品标识（如 sema-code-vscode）；不传或空串则本进程不采集，仅构造时生效
    # ---- 来源限定：host 域内容与各类生效的域，仅构造时生效；校验不通过 init 报 CONFIG_INVALID ----
    models: ModelsInput  # 宿主内置的模型与指针；host 模型只读，查询接口不回传 apiKey
    mcpServers: List[MCPServerInput]
    hooks: HooksInput
    skills: SkillsInput
    agents: AgentsInput
    commands: CommandsInput
    scopes: ScopesConfig
    # ---- 持久化保护 ----
    encryption: EncryptionConfig  # 仅构造时生效
    disableLLMLog: bool  # 不写模型调用日志；缺省：没传 encryption 为 False，传了为 True；支持运行期更新
    disableEventLog: bool  # 不写事件日志；缺省规则同上；支持运行期更新


class UpdatableCoreConfig(TypedDict, total=False):
    """updateCoreConfig 可动态更新的核心配置子集（≙ core UpdatableCoreConfig）。"""
    lang: Literal["zh", "en", "de", "fr", "it"]
    stream: bool
    thinking: bool
    systemPrompt: str
    customRules: str
    skipFileEditPermission: bool
    skipShellExecPermission: bool
    skipSkillPermission: bool
    skipMCPToolPermission: bool
    skipFetchUrlPermission: bool
    fetchUrlBrowserUserAgent: bool
    skipExternalFileReadPermission: bool
    disableBackgroundTasks: bool
    enableToolSearch: bool
    enableInputPrediction: bool
    disableLLMLog: bool
    disableEventLog: bool


class ModelConfig(TypedDict):
    provider: str
    modelName: str
    baseURL: str
    apiKey: str
    maxTokens: int
    contextLength: int
    adapt: AdapterType
    thinkingHistoryPolicy: NotRequired[ThinkingHistoryPolicy]  # 缺失等同 preserve


class ModelProfile(TypedDict):
    """get_model_profile 返回：磁盘上的完整模型 profile，供配置页编辑回填；host 模型的 apiKey 为空串。"""
    name: str
    provider: str
    modelName: str
    baseURL: NotRequired[str]
    apiKey: str
    maxTokens: int
    contextLength: int
    adapt: AdapterType
    thinkingHistoryPolicy: NotRequired[ThinkingHistoryPolicy]


class TaskConfig(TypedDict):
    """applyTaskModel 参数：主/快模型指针；image 为文生图指针（只在返回值里出现，空串表示未启用）。"""
    main: str
    quick: str
    image: NotRequired[str]


class ImageModelConfig(TypedDict):
    """add_image_model 入参：文生图模型（进程级，无会话级覆盖）。"""
    provider: str
    modelName: str
    baseURL: str
    apiKey: str


class ImageModelProfile(TypedDict):
    """get_image_model_profile 返回：磁盘上的完整文生图模型 profile；host 模型的 apiKey 为空串。"""
    name: str
    provider: str
    modelName: str
    baseURL: str
    apiKey: str


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
    """addModel/delModel/switchModel/applyTaskModel/getModelData 及 *ImageModel 返回；亦为 model:update 合成事件数据。"""
    modelName: str
    modelList: List[str]
    taskConfig: TaskConfig
    imageModelList: NotRequired[List[str]]  # 文生图模型列表（与 modelList 分开）
    hostModels: NotRequired[List[str]]  # 来自宿主（host 域）的模型名，含对话与文生图模型；只读，不可删改


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
    """getMCPServerInfo 等返回项；亦为 mcp:server:status 事件数据。host 条目的 config.env / headers 值打码为 "***"。"""
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
    prompt: str  # 内联（private）子代理在查询接口里为空串
    locate: NotRequired[AgentScope]
    filePath: NotRequired[str]  # 内联子代理没有
    private: NotRequired[bool]  # 宿主内联传入：正文只在内存里，查询接口不回传


class SkillConfig(TypedDict):
    name: str
    description: str
    prompt: str  # 内联（private）skill 在查询接口里为空串
    locate: NotRequired[SkillScope]
    filePath: NotRequired[str]  # SKILL.md 路径；内联 skill 没有
    status: NotRequired[bool]  # 是否启用（settings 的 disabledSkills 控制，用户级+项目级并集；缺省视为启用；builtin / host 恒为启用）
    private: NotRequired[bool]  # 宿主内联传入：正文与文本子文件只在内存里，不出现在查询接口与事件里
    resourceDir: NotRequired[str]  # 内联 skill 的脚本、资源所在磁盘目录（绝对路径）


class CommandConfig(TypedDict):
    name: str
    description: str
    prompt: str  # 内联（private）命令在查询接口里为空串
    argumentHint: NotRequired[Union[str, List[str]]]
    locate: NotRequired[CommandScope]
    filePath: NotRequired[str]  # 内联命令没有
    private: NotRequired[bool]  # 宿主内联传入：正文只在内存里，查询接口不回传


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
    pluginName: NotRequired[str]  # 仅 source == "plugin"：所属插件名
    message: str


class HookEntryInfo(TypedDict):
    event: str
    source: HookScope
    pluginName: NotRequired[str]  # 仅 source == "plugin"：所属插件名
    matcher: NotRequired[str]
    command: str
    timeout: NotRequired[int]  # 配置原值（秒），未配则缺省（运行时默认 60s）
    status: HookEntryStatus
    statusReason: NotRequired[str]
    filePath: NotRequired[str]  # "绝对路径:起始行-结束行"（事件块粒度）；host 条目无此字段


class HooksInfo(TypedDict):
    userConfigPath: str  # user 域没生效（scopes.hooks 未含 user）时为空串
    projectConfigPath: str  # project 域没生效时为空串
    userConfigExists: bool  # user 域没生效时恒为 False
    projectConfigExists: bool  # project 域没生效时恒为 False
    parseErrors: List[HookParseError]
    events: Dict[str, List[HookEntryInfo]]  # 按事件分组，host 在前、插件其次、用户级再次、项目级追加


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
    hooks: List[PluginComponentEntry]


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


# ==================== 使用统计（get_usage_stats）====================

class UsageTokens(TypedDict):
    hit: int     # 缓存命中的输入 token
    miss: int    # 未命中缓存的输入 token
    output: int  # 输出 token


class UsageModelStat(TypedDict):
    requests: int
    hitKnown: bool  # 服务商是否返回过缓存命中数；False 时 tokens.hit 恒为 0，miss 即总输入
    tokens: UsageTokens


class UsageToolStat(TypedDict):
    calls: int
    errors: int


class UsageSkillStat(TypedDict):
    calls: int
    lastAt: int  # 最近一次调用时间戳（毫秒）


class UsageDayData(TypedDict):
    """单日聚合：models/tools/skills 按名称聚合，sessions 为当天去重后的会话 id。"""
    requests: int
    tokens: UsageTokens
    models: Dict[str, UsageModelStat]
    tools: Dict[str, UsageToolStat]
    skills: Dict[str, UsageSkillStat]
    sessions: List[str]


class UsageTotals(TypedDict):
    requests: int
    tokens: UsageTokens
    sessions: int  # 全部记录 sessionId 去重数
    days: int      # 有记录的日期数


class UsageStatsData(TypedDict):
    """get_usage_stats 返回：since=最早记录日期 'YYYY-MM-DD'（无数据为 None），days 只含近 366 天且有记录的日期。"""
    since: Optional[str]
    updatedAt: int
    totals: UsageTotals
    days: Dict[str, UsageDayData]


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


# ==================== 长期目标（/goal；getGoal 返回值与 goal:update 事件载荷）====================

# running=自主循环中；paused=用户暂停/中断、系统止损、重开会话，可 resume；
# completed/blocked=模型自报，blocked 可 resume；不要了用 clear_goal 删除
GoalStatus = Literal["running", "paused", "completed", "blocked"]


class GoalState(TypedDict):
    text: str
    status: GoalStatus
    round: int              # 起始轮为 1，仅自动续轮加一
    maxRounds: int          # 因上限暂停后 resume 时累加
    idleRounds: int         # 连续无 tool_use 的目标轮数
    summary: NotRequired[str]   # 模型自报完成 / 受阻时给出的总结
    createdAt: int
    updatedAt: int


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
    code: NotRequired[SemaErrorCode]  # 稳定错误码（如历史密文解不开的 HISTORY_DECRYPT_FAILED）；没有对应错误码时缺省


# ≙ core CreateSessionResult；注意 SDK 的 create_session 直接返回 SemaSession（已解包），失败抛 SemaBridgeException（code 在 .code 上）。
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

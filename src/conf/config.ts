// sema数据存储目录
export const SEMA_ROOT = '~/.sema'

// 模型配置文件
export const MODEL_CONF_FILE_PATH = 'model.conf'

// 项目配置文件
export const PROJECT_CONF_FILE_PATH = 'projects.conf'
export const PROJECT_LENGTH_LIMIT = 100  // 项目数量限制
export const PROJECT_HISTORY_LENGTH_LIMIT = 30  // 项目历史输入限制

// 会话历史记录
export const HISTORY_DIR_PATH = 'history'
export const HISTORY_FILES_RETAIN_COUNT = 200  // 会话历史记录文件保留数量
export const PER_PROJECT_HISTORY_LENGTH_LIMIT = 50 // 每个项目历史记录文件保留数量
export const HISTORY_CLEANUP_INTERVAL = 60 * 60 * 1000;  // 清理会话历史记录文件的时间间隔（毫秒）

// 会话 Fork 文件级快照（内容寻址 blob + 每会话 editlog）
export const SNAPSHOTS_DIR_PATH = 'snapshots'

// 服务日志10
export const LOG_DIR_PATH = 'logs'
export const SERVICE_LOG_FILES_RETAIN_COUNT = 7  // 服务日志文件保留数量

// LLM调用日志
export const LLM_LOG_DIR_PATH = 'llm_logs'
export const LLM_LOG_FILES_RETAIN_COUNT = 10  // 大模型日志文件保留数量
export const LLM_LOG_CLEANUP_INTERVAL = 60 * 60 * 1000;  // 清理LLM日志文件的时间间隔（毫秒）

// LLM调用轨迹归档
export const TRACKS_DIR_PATH = 'tracks'
export const TRACKS_FILES_RETAIN_COUNT = 30  // 轨迹归档文件保留数量

// 事件日志
export const EVENT_DIR_PATH = 'event'
export const EVENT_LOG_FILES_RETAIN_COUNT = 10  // 事件日志文件保留数量
export const EVENT_LOG_CLEANUP_INTERVAL = 60 * 60 * 1000;  // 清理事件日志文件的时间间隔（毫秒）

// 附件（宿主转存的粘贴文本、用户附图原图、模型生成的可视化 html 与图片）；归属登记与退场见 util/attachmentLedger.ts
export const ATTACHMENTS_DIR_PATH = 'attachments'
export const ATTACHMENTS_RETAIN_COUNT = 100  // 期限兜底：排在最新这么多个之内的附件目录不删
export const ATTACHMENTS_RETAIN_MS = 30 * 24 * 60 * 60 * 1000  // 期限兜底：这段时间内写入的附件目录不删（毫秒）
export const ATTACHMENTS_MAX_BYTES = 2 * 1024 * 1024 * 1024  // 体积上限：附件目录总体积超过此值时从最旧的删起（字节）
export const ATTACHMENTS_EMPTY_DIR_TTL = 60 * 60 * 1000  // 空附件目录保留时长（毫秒）
export const ATTACHMENT_LEDGER_ORPHAN_TTL = 24 * 60 * 60 * 1000  // 没有对应会话历史的附件清单保留时长（毫秒）

// 使用统计
export const STATS_DIR_PATH = 'stats'
export const USAGE_STATS_FLUSH_INTERVAL = 10 * 1000  // 增量账本落盘延迟（毫秒）

// 长期目标（/goal）自主循环
export const GOAL_MAX_ROUNDS = 10        // 目标轮数上限，到达置 paused；/goal resume 时累加
export const GOAL_MAX_IDLE_ROUNDS = 3    // 连续无 tool_use 的目标轮数达到即置 paused（无进展止损）
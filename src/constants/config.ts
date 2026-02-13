// sema数据存储目录
export const SEMA_ROOT = '~/.sema'

// 模型配置文件
export const MODEL_CONF_FILE_PATH = 'model.conf'

// 项目配置文件
export const PROJECT_CONF_FILE_PATH = 'projects.conf'
export const PROJECT_LENGTH_LIMIT = 20  // 项目数量限制
export const PROJECT_HISTORY_LENGTH_LIMIT = 10  // 项目历史输入限制

// 会话历史记录
export const HISTORY_DIR_PATH = 'history'
export const HISTORY_FILES_RETAIN_COUNT = 200  // 会话历史记录文件保留数量
export const PER_PROJECT_HISTORY_LENGTH_LIMIT = 50 // 每个项目历史记录文件保留数量
export const HISTORY_CLEANUP_INTERVAL = 60 * 60 * 1000;  // 清理会话历史记录文件的时间间隔（毫秒）

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
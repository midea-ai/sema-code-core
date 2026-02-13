import * as path from 'path';
import * as os from 'os';
import { getDayTimeString } from '../util/time';
import { normalizeFilePath } from './file';
import {
  SEMA_ROOT,
  MODEL_CONF_FILE_PATH,
  PROJECT_CONF_FILE_PATH,
  HISTORY_DIR_PATH,
  LOG_DIR_PATH,
  LLM_LOG_DIR_PATH,
  TRACKS_DIR_PATH,
  EVENT_DIR_PATH
} from '../constants/config';

/**
 * 获取 Sema 根目录路径
 * 默认为 ~/.sema，可通过环境变量 SEMA_ROOT 自定义
 * 跨平台兼容：Windows、macOS、Linux
 */
export function getSemaRootDir(): string {
  const customRoot = process.env.SEMA_ROOT;
  if (customRoot) {
    // Windows 平台下标准化路径（处理 /c/Users/... 格式）
    if (process.platform === 'win32') {
      return normalizeFilePath(customRoot);
    }
    return path.resolve(customRoot);
  }

  // 处理 SEMA_ROOT 常量中的 ~ 符号，跨平台兼容
  if (SEMA_ROOT.startsWith('~/')) {
    return path.join(os.homedir(), SEMA_ROOT.slice(2));
  }

  return path.resolve(SEMA_ROOT);
}

/**
 * 获取模型配置文件路径
 */
export function getModelConfigFilePath(): string {
  return path.join(getSemaRootDir(), MODEL_CONF_FILE_PATH);
}

/**
 * 获取项目配置文件路径
 */
export function getProjectConfigFilePath(): string {
  return path.join(getSemaRootDir(), PROJECT_CONF_FILE_PATH);
}

/**
 * 获取历史记录根目录路径
 */
export function getHistoryDir(): string {
  return path.join(getSemaRootDir(), HISTORY_DIR_PATH);
}

/**
 * 将项目绝对路径转换为目录名
 * 规则：路径分隔符替换为 -，开头加 -，Windows盘符的冒号去掉
 * 例如：
 *   /Users/xxx/project -> -Users-xxx-project
 *   C:\Users\xxx\project -> -C-Users-xxx-project
 * @param projectPath 项目绝对路径
 */
export function projectPathToDirName(projectPath: string): string {
  // 标准化路径
  let normalized = path.normalize(projectPath);

  // Windows 路径处理：去掉盘符后的冒号 (C: -> C)
  normalized = normalized.replace(/^([A-Za-z]):/, '$1');

  // 将路径分隔符（/ 或 \）替换为 -
  // 使用正则同时匹配正斜杠和反斜杠
  const dirName = normalized.replace(/[/\\]+/g, '-');

  // 确保开头有 -（如果原路径以分隔符开头，替换后已经有 -）
  // 如果是 Windows 路径（如 C-Users-xxx），需要在开头加 -
  if (!dirName.startsWith('-')) {
    return '-' + dirName;
  }

  return dirName;
}

/**
 * 获取项目的历史记录目录路径
 * @param projectPath 项目绝对路径
 */
export function getProjectHistoryDir(projectPath: string): string {
  const dirName = projectPathToDirName(projectPath);
  return path.join(getHistoryDir(), dirName);
}

/**
 * 获取历史记录文件路径
 * @param sessionId 会话ID
 * @param projectPath 项目绝对路径（可选，如果不提供则使用旧的平铺存储方式）
 */
export function getHistoryFilePath(sessionId: string, projectPath?: string): string {
  const dateStr = getDayTimeString();
  const filename = `${dateStr}_${sessionId}.json`;

  if (projectPath) {
    return path.join(getProjectHistoryDir(projectPath), filename);
  }

  // 兼容旧逻辑
  return path.join(getHistoryDir(), filename);
}

/**
 * 获取日志目录路径
 */
export function getLogsDir(): string {
  return path.join(getSemaRootDir(), LOG_DIR_PATH);
}

/**
 * 获取LLM日志目录路径
 */
export function getLLMLogsDir(): string {
  return path.join(getSemaRootDir(), LLM_LOG_DIR_PATH);
}

/**
 * 获取轨迹归档目录路径
 */
export function getTracksDir(): string {
  return path.join(getSemaRootDir(), TRACKS_DIR_PATH);
}

/**
 * 获取缓存目录路径
 */
export function getCacheDir(): string {
  return path.join(getSemaRootDir(), 'cache');
}

/**
 * 获取LLM缓存文件路径
 */
export function getLLMCacheFilePath(): string {
  return path.join(getCacheDir(), 'llm-cache.json');
}

/**
 * 获取事件日志目录路径
 */
export function getEventDir(): string {
  return path.join(getSemaRootDir(), EVENT_DIR_PATH);
}

/**
 * 获取全局 Agent.md 文件路径
 * 位于根目录下的 /.sema/AGENT.md
 */
export function getGlobalAgentMdPath(): string {
  return path.join(getSemaRootDir(), 'AGENT.md');
}

/**
 * 获取全局 MCP配置 文件路径
 * 位于根目录下的 /.sema/mcp.json
 */
export function getGlobalMCPFilePath(): string {
  return path.join(getSemaRootDir(), 'mcp.json');
}
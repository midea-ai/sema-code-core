import * as path from 'path';
import { getDayTimeString } from './time';
import { expandHome, unixDriveToNative } from './platform';
import {
  SEMA_ROOT,
  MODEL_CONF_FILE_PATH,
  PROJECT_CONF_FILE_PATH,
  HISTORY_DIR_PATH,
  LOG_DIR_PATH,
  LLM_LOG_DIR_PATH,
  TRACKS_DIR_PATH,
  EVENT_DIR_PATH
} from '../conf/config';

let _semaRootDir: string | undefined;

/**
 * 获取 Sema 根目录路径
 * 默认为 ~/.sema，可通过环境变量 SEMA_ROOT 自定义
 * 跨平台兼容：Windows、macOS、Linux
 */
export function getSemaRootDir(): string {
  if (!_semaRootDir) {
    const customRoot = process.env.SEMA_ROOT;
    _semaRootDir = customRoot
      ? path.resolve(unixDriveToNative(customRoot))
      : expandHome(SEMA_ROOT);
    // console.log('[getSemaRootDir]', _semaRootDir);
  }
  return _semaRootDir;
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
 * 获取项目的历史记录目录路径
 * 将项目绝对路径转换为目录名：路径分隔符替换为 -，开头加 -，Windows盘符的冒号去掉
 * 例如：/Users/xxx/project -> -Users-xxx-project
 */
export function getProjectHistoryDir(projectPath: string): string {
  let normalized = path.normalize(projectPath);
  normalized = normalized.replace(/^([A-Za-z]):/, '$1');
  const dirName = normalized.replace(/[/\\]+/g, '-');
  return path.join(getHistoryDir(), dirName.startsWith('-') ? dirName : '-' + dirName);
}

/**
 * 获取历史记录文件路径
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

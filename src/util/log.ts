import * as fs from 'fs';
import * as path from 'path';
import { getDayTimeString, getCurrentLocalTimeString, getCurrentTimestamp, getTimeString } from './time';
import { SERVICE_LOG_FILES_RETAIN_COUNT } from '../constants/config';
import { getLogsDir } from './savePath';

export type LogLevel = 'none' | 'debug' | 'info' | 'warn' | 'error';

// 日志级别优先级映射
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  none: 999 // 最高级别，禁用所有日志
};

// 全局配置
let globalLogLevel: LogLevel = 'info';

// 清理日志文件的时间间隔（毫秒）
let lastCleanupTime: number = 0;
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1小时

/**
 * 设置全局日志级别
 * @param level 日志级别，默认 'info'
 */
export const setLogLevel = (level: LogLevel = 'info'): void => {
  globalLogLevel = level;
};

/**
 * 判断是否应该记录该级别的日志
 */
const shouldLog = (level: LogLevel): boolean => {
  return LOG_LEVELS[level] >= LOG_LEVELS[globalLogLevel];
};

/**
 * 获取当前日期的日志文件路径
 */
const getLogFilePath = (): string => {
  const dateStr = getDayTimeString(); // 只取日期部分 YYYY-MM-DD

  // 如果有sessionId，则在文件名中包含它
  const filename = `${dateStr}.log`;
  return path.join(getLogsDir(), filename);
};


/**
 * 获取调用者信息（文件名:行号）
 */
const getCallerInfo = (): string => {
  const stack = new Error().stack;
  if (!stack) return 'unknown:0';

  const lines = stack.split('\n');


  // 跳过当前函数、formatMessage、writeLog和具体日志函数的调用栈
  // 从调用栈看：0=Error, 1=getCallerInfo, 2=formatMessage, 3=writeLog, 4=logInfo/logWarn等, 5=实际调用者
  for (let i = 5; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line) {
      // 主要格式: at ClassName.methodName (/path/file.js:line:column)
      let match = line.match(/at .+ \(([^\/\\]+)\.js:(\d+):\d+\)/);
      if (match) {
        // 将.js替换为.ts显示，并提取文件名
        const filename = `${match[1]}.ts`;
        return `${filename}:${match[2]}`;
      }

      // 备用格式: at functionName (/path/file.js:line:column)
      match = line.match(/at [^(]+ \(.*\/([^\/\\]+)\.js:(\d+):\d+\)/);
      if (match) {
        const filename = `${match[1]}.ts`;
        return `${filename}:${match[2]}`;
      }

      // 直接格式: at /path/file.js:line:column
      match = line.match(/at .*\/([^\/\\]+)\.js:(\d+):\d+/);
      if (match) {
        const filename = `${match[1]}.ts`;
        return `${filename}:${match[2]}`;
      }
    }
  }
  return 'unknown:0';
};

/**
 * 格式化日志消息
 */
const formatMessage = (level: LogLevel, message: string): string => {
  const timestamp = getTimeString(); // 使用时分秒格式
  const levelStr = level.toUpperCase();
  const callerInfo = getCallerInfo();
  return `[${timestamp}] [${levelStr}] [${callerInfo}]: ${message}`;
};

/**
 * 写入日志到文件和控制台
 */
const writeLog = (level: LogLevel, message: string, consoleMethod: (...args: any[]) => void): void => {
  if (!shouldLog(level)) {
    return;
  }

  const formattedMessage = formatMessage(level, message);

  // 输出到控制台
  consoleMethod(formattedMessage);

  // 写入文件
  try {
    // 确保日志目录存在
    const logsDir = getLogsDir();
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFilePath = getLogFilePath();
    fs.appendFileSync(logFilePath, formattedMessage + '\n', 'utf8');

    // 定时清理日志文件（每小时最多执行一次）
    const nowTimestamp = getCurrentTimestamp();
    if (nowTimestamp - lastCleanupTime > CLEANUP_INTERVAL) {
      lastCleanupTime = nowTimestamp;
      // 异步执行清理，避免阻塞日志写入
      setImmediate(() => {
        cleanupLogFiles();
      });
    }
  } catch (err) {
    // 避免递归调用logError，直接使用console.error
    if (level !== 'error') {
      console.error('日志写入失败:', err);
    }
  }
};

/**
 * 记录 debug 级别日志
 */
export const logDebug = (message: string): void => {
  writeLog('debug', message, console.log);
};

/**
 * 记录 info 级别日志
 */
export const logInfo = (message: string): void => {
  writeLog('info', message, console.log);
};

/**
 * 记录 warn 级别日志
 */
export const logWarn = (warning: string): void => {
  writeLog('warn', warning, console.warn);
};

/**
 * 记录 error 级别日志
 */
export const logError = (error: unknown): void => {
  if (error instanceof Error) {
    // 权限中断 或 用户中断信息 不记录
    if (error.message === 'Request cancelled by user' || error.message === 'Operation was interrupted by user') {
      return;
    }
  }
  
  let message: string;

  if (error instanceof Error) {
    message = `${error.message}\n${error.stack || ''}`;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = JSON.stringify(error);
  }

  writeLog('error', message, console.error);
};

/**
 * 通用文件清理函数
 * @param dir 目录路径
 * @param extension 文件扩展名
 * @param maxFiles 最大保留文件数
 * @param logType 日志类型（用于打印信息）
 */
const cleanupFiles = (dir: string, extension: string, maxFiles: number = 30): void => {
  try {
    if (!fs.existsSync(dir)) {
      return;
    }

    // 读取指定扩展名的文件
    const files = fs.readdirSync(dir)
      .filter(file => file.endsWith(extension))
      .map(file => ({
        name: file,
        path: path.join(dir, file),
        mtime: fs.statSync(path.join(dir, file)).mtime
      }))
      // 按修改时间降序排序（最新的在前面）
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    // 如果文件数量超过指定数量，删除多余的文件
    if (files.length > maxFiles) {
      const filesToDelete = files.slice(maxFiles);
      for (const file of filesToDelete) {
        try {
          fs.unlinkSync(file.path);
        } catch (err) {
        }
      }
    }
  } catch (err) {
  }
};

/**
 * 清理普通日志文件，只保留最近指定数量的文件（按修改时间排序）
 */
const cleanupLogFiles = (): void => {
  cleanupFiles(getLogsDir(), '.log', SERVICE_LOG_FILES_RETAIN_COUNT);
};
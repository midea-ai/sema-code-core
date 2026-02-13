import * as fs from 'fs';
import * as path from 'path';
import { getCurrentTimestamp, getDayTimeString, getTimeString } from './time';
import { LLM_LOG_FILES_RETAIN_COUNT, TRACKS_FILES_RETAIN_COUNT, LLM_LOG_CLEANUP_INTERVAL, EVENT_LOG_FILES_RETAIN_COUNT, EVENT_LOG_CLEANUP_INTERVAL } from '../constants/config';
import { getLLMLogsDir, getTracksDir, getEventDir } from './savePath';
import { logError } from './log';
import { getConfManager } from '../manager/ConfManager';
import { getStateManager } from '../manager/StateManager';

// 清理LLM日志文件的时间间隔（毫秒）
let lastLLMCleanupTime: number = 0;
let lastEventCleanupTime: number = 0;

/**
 * 获取项目名（从workingDir中提取最后一个目录名）
 */
const getProjectName = (): string => {
  try {
    const coreConfig = getConfManager().getCoreConfig();
    const workingDir = coreConfig?.workingDir;
    if (workingDir) {
      return path.basename(workingDir);
    }
    return 'unknown';
  } catch (err) {
    return 'unknown';
  }
};

/**
 * 获取LLM日志文件路径
 */
const getLLMLogFilePath = (): string => {
  const dateStr = getDayTimeString(); // 只取日期部分 YYYY-MM-DD
  const llmLogsDir = getLLMLogsDir();

  // 确保目录存在
  if (!fs.existsSync(llmLogsDir)) {
    fs.mkdirSync(llmLogsDir, { recursive: true });
  }

  // 获取sessionId（通过 StateManager）
  const stateManager = getStateManager();
  const sessionId = stateManager.getSessionId();

  // 如果有sessionId，则在文件名中包含它
  const filename = sessionId ? `${dateStr}_${sessionId}.log` : `${dateStr}.log`;
  return path.join(llmLogsDir, filename);
};

/**
 * 记录LLM请求body到专门的日志文件
 * 格式: [HH:MM:SS]${body}
 * @param body 请求的JSON体
 */
export const logLLMRequest = (body: any): void => {
  try {
    const timeStr = getTimeString(); // 使用时分秒格式

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const logLine = `[${timeStr}]${bodyStr}`;

    const logFilePath = getLLMLogFilePath();
    fs.appendFileSync(logFilePath, logLine + '\n', 'utf8');

    // 定时清理LLM日志文件（每小时最多执行一次）
    const nowTimestamp = getCurrentTimestamp();
    if (nowTimestamp - lastLLMCleanupTime > LLM_LOG_CLEANUP_INTERVAL) {
      lastLLMCleanupTime = nowTimestamp;
      // 异步执行清理，避免阻塞日志写入
      setImmediate(() => {
        cleanupLLMLogFiles();
      });
    }
  } catch (err) {
    logError(err);
  }
};

/**
 * 记录LLM响应到专门的日志文件
 * 格式: [HH:MM:SS]${response}
 * @param assistantMessage LLM响应消息
 */
export const logLLMResponse = (assistantMessage: any): void => {
  try {
    const timeStr = getTimeString(); // 使用时分秒格式

    // 从AssistantMessage中提取文本内容
    let content = '';
    let thinking = '';
    const contentBlocks = assistantMessage.message.content || [];
    for (const block of contentBlocks) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'thinking') {
        thinking += block.thinking;
      }
    }

    // 从AssistantMessage中提取工具调用
    const toolCalls = contentBlocks
      .filter((block: any) => block.type === 'tool_use')
      .map((block: any) => ({
        name: block.name,
        args: block.input
      }));

    const responseData = {
      ...(thinking && { thinking }),
      content,
      ...(toolCalls.length > 0 && { toolCalls })
    };

    const logLine = `[${timeStr}]${JSON.stringify(responseData)}`;

    const logFilePath = getLLMLogFilePath();
    fs.appendFileSync(logFilePath, logLine + '\n', 'utf8');

    // 定时清理LLM日志文件（每小时最多执行一次）
    const nowTimestamp = getCurrentTimestamp();
    if (nowTimestamp - lastLLMCleanupTime > LLM_LOG_CLEANUP_INTERVAL) {
      lastLLMCleanupTime = nowTimestamp;
      // 异步执行清理，避免阻塞日志写入
      setImmediate(() => {
        cleanupLLMLogFiles();
      });
    }
  } catch (err) {
    logError(err);
  }
};

/**
 * 提取LLM日志中messages最长的请求及其后续响应
 * @param logContent 原始日志内容
 * @returns 过滤后的日志内容
 */
const extractLongestLLMConversation = (logContent: string): string => {
  const lines = logContent.split('\n');
  const parsedEntries: Array<{
    timestamp: string;
    data: any;
    originalLine: string;
    isRequest: boolean;
    messagesLength?: number;
  }> = [];

  // 解析所有日志条目
  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\](.+)$/);
      if (!match) continue;

      const timestamp = match[1];
      const jsonStr = match[2];
      const jsonData = JSON.parse(jsonStr);

      const isRequest = !!jsonData.messages;
      const messagesLength = isRequest ? jsonData.messages.length : undefined;

      parsedEntries.push({
        timestamp,
        data: jsonData,
        originalLine: line,
        isRequest,
        messagesLength
      });
    } catch (err) {
      // 解析失败，跳过
      continue;
    }
  }

  // 找到messages最长的请求
  let longestRequest = null;
  let maxLength = 0;

  for (const entry of parsedEntries) {
    if (entry.isRequest && entry.messagesLength! > maxLength) {
        maxLength = entry.messagesLength!;
        longestRequest = entry;
      }
    }

  if (!longestRequest) {
    return '';
  }

  // 找到该请求之后的第一个响应
  const requestIndex = parsedEntries.indexOf(longestRequest);
  let nextResponse = null;

  for (let i = requestIndex + 1; i < parsedEntries.length; i++) {
    if (!parsedEntries[i].isRequest) {
      nextResponse = parsedEntries[i];
      break;
    }
  }

  // 构建结果
  const resultLines: string[] = [];
  const projectName = getProjectName();

  // 处理请求：只保留model和messages字段，过滤系统消息
  const filteredMessages = longestRequest.data.messages.filter((msg: any) => msg.role !== 'system');
  if (filteredMessages.length > 0) {
    const filteredRequest = {
      model: longestRequest.data.model,
      messages: filteredMessages
    };
    resultLines.push(`[${longestRequest.timestamp}][${projectName}]${JSON.stringify(filteredRequest)}`);
  }

  // 添加响应（如果存在）
  if (nextResponse) {
    resultLines.push(nextResponse.originalLine);
  }

  return resultLines.join('\n');
};

/**
 * 将LLM日志文件归档到tracks目录
 * @param filesToArchive 需要归档的文件列表
 */
const archiveLLMLogFiles = (filesToArchive: Array<{name: string, path: string, mtime: Date}>): void => {
  try {
    const tracksDir = getTracksDir();

    // 确保tracks目录存在
    if (!fs.existsSync(tracksDir)) {
      fs.mkdirSync(tracksDir, { recursive: true });
    }

    for (const file of filesToArchive) {
      try {
        // 读取原始文件内容
        const originalContent = fs.readFileSync(file.path, 'utf8');

        // 提取最长对话内容
        const extractedContent = extractLongestLLMConversation(originalContent);

        // 如果提取后还有内容，则追加到tracks目录对应的日期文件
        if (extractedContent.trim()) {
          // 从文件名中提取日期部分 (格式: YYYY-MM-DD_sessionId.log 或 YYYY-MM-DD.log)
          const dateMatch = file.name.match(/^(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            const dateStr = dateMatch[1];
            const archiveFilePath = path.join(tracksDir, `${dateStr}.log`);
            fs.appendFileSync(archiveFilePath, extractedContent + '\n', 'utf8');
          }
        }

        // 删除原始文件
        fs.unlinkSync(file.path);
      } catch (err) {
        logError(`归档文件失败: ${file.name}, 错误: ${err}`);
      }
    }

    // 清理tracks目录中过旧的文件
    cleanupFiles(tracksDir, '.log', TRACKS_FILES_RETAIN_COUNT);
  } catch (err) {
    logError(`归档过程出错: ${err}`);
  }
};

/**
 * 通用文件清理函数
 * @param dir 目录路径
 * @param extension 文件扩展名
 * @param maxFiles 最大保留文件数
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
 * 清理LLM日志文件，只保留最近指定数量的文件（按修改时间排序）
 * 被删除的文件会被归档到tracks目录
 */
const cleanupLLMLogFiles = (): void => {
  try {
    const llmLogsDir = getLLMLogsDir();
    if (!fs.existsSync(llmLogsDir)) {
      return;
    }

    // 读取.log文件
    const files = fs.readdirSync(llmLogsDir)
      .filter(file => file.endsWith('.log'))
      .map(file => ({
        name: file,
        path: path.join(llmLogsDir, file),
        mtime: fs.statSync(path.join(llmLogsDir, file)).mtime
      }))
      // 按修改时间降序排序（最新的在前面）
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    // 如果文件数量超过指定数量，归档多余的文件
    if (files.length > LLM_LOG_FILES_RETAIN_COUNT) {
      const filesToArchive = files.slice(LLM_LOG_FILES_RETAIN_COUNT);
      archiveLLMLogFiles(filesToArchive);
    }
  } catch (err) {
    logError(`清理LLM日志文件出错: ${err}`);
  }
};

// ============================================================
// 事件日志
// ============================================================

/**
 * 获取事件日志文件路径
 */
const getEventLogFilePath = (): string => {
  const dateStr = getDayTimeString();
  const eventDir = getEventDir();

  if (!fs.existsSync(eventDir)) {
    fs.mkdirSync(eventDir, { recursive: true });
  }

  const stateManager = getStateManager();
  const sessionId = stateManager.getSessionId();

  const filename = sessionId ? `${dateStr}_${sessionId}.log` : `${dateStr}.log`;
  return path.join(eventDir, filename);
};

/**
 * 记录事件到日志文件
 * 格式: [HH:MM:SS]${event}|${data}
 * @param event 事件名
 * @param data 事件数据
 */
export const logEvent = (event: string, data: any): void => {
  try {
    const timeStr = getTimeString();
    const dataStr = data !== undefined ? JSON.stringify(data) : '';
    const logLine = `[${timeStr}]${event}|${dataStr}`;

    const logFilePath = getEventLogFilePath();
    fs.appendFileSync(logFilePath, logLine + '\n', 'utf8');

    // 定时清理事件日志文件
    const nowTimestamp = getCurrentTimestamp();
    if (nowTimestamp - lastEventCleanupTime > EVENT_LOG_CLEANUP_INTERVAL) {
      lastEventCleanupTime = nowTimestamp;
      setImmediate(() => {
        cleanupEventLogFiles();
      });
    }
  } catch (err) {
    logError(err);
  }
};

/**
 * 清理事件日志文件，只保留最近指定数量的文件
 */
const cleanupEventLogFiles = (): void => {
  try {
    const eventDir = getEventDir();
    if (!fs.existsSync(eventDir)) {
      return;
    }

    const files = fs.readdirSync(eventDir)
      .filter(file => file.endsWith('.log'))
      .map(file => ({
        name: file,
        path: path.join(eventDir, file),
        mtime: fs.statSync(path.join(eventDir, file)).mtime
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    if (files.length > EVENT_LOG_FILES_RETAIN_COUNT) {
      const filesToDelete = files.slice(EVENT_LOG_FILES_RETAIN_COUNT);
      for (const file of filesToDelete) {
        try {
          fs.unlinkSync(file.path);
        } catch (err) {
        }
      }
    }
  } catch (err) {
    logError(`清理事件日志文件出错: ${err}`);
  }
};
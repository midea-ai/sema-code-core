import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as crypto from 'crypto';
import { nowMillis, getDayTimeString, getTimeString } from './time';
import { LLM_LOG_FILES_RETAIN_COUNT, TRACKS_FILES_RETAIN_COUNT, LLM_LOG_CLEANUP_INTERVAL, EVENT_LOG_FILES_RETAIN_COUNT, EVENT_LOG_CLEANUP_INTERVAL } from '../conf/config';
import { getLLMLogsDir, getTracksDir, getEventDir } from './savePath';
import { logError } from './log';
import { getConfManager } from '../manager/ConfManager';

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
const getLLMLogFilePath = (sessionId?: string): string => {
  const dateStr = getDayTimeString(); // 只取日期部分 YYYY-MM-DD
  const llmLogsDir = getLLMLogsDir();

  // 确保目录存在
  if (!fs.existsSync(llmLogsDir)) {
    fs.mkdirSync(llmLogsDir, { recursive: true });
  }

  // 有 sessionId 时按会话拆分日志文件
  const filename = sessionId ? `${dateStr}_${sessionId}.log` : `${dateStr}.log`;
  return path.join(llmLogsDir, filename);
};

// ============================================================
// 图片去重落盘：base64 按内容哈希存到 llm_logs/images/<hash>.<ext>，日志里只留占位
// ============================================================

const IMAGE_REF_RE = /<image hash=([0-9a-f]{40})/g;

const getImagesDir = (): string => path.join(getLLMLogsDir(), 'images');

/**
 * 把一段 base64 图片存到 images 目录，返回日志占位
 * 已存在则只刷新 mtime，让"被重新引用"的旧图片也进入清理时的 mtime 保护窗口
 */
const saveImage = (base64: string, mediaType?: string): string => {
  const hash = crypto.createHash('sha1').update(base64).digest('hex');
  const placeholder = `<image hash=${hash} size=${base64.length}>`;
  try {
    const ext = (mediaType || 'image/png').split('/')[1] || 'png';
    const imagesDir = getImagesDir();
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }
    const imagePath = path.join(imagesDir, `${hash}.${ext}`);
    if (fs.existsSync(imagePath)) {
      const now = new Date();
      fs.utimesSync(imagePath, now, now);
    } else {
      fs.writeFileSync(imagePath, Buffer.from(base64, 'base64'));
    }
  } catch (err) {
    logError(`保存LLM日志图片失败: ${err}`);
  }
  return placeholder;
};

/**
 * 返回一份 messages 里图片 base64 已换成占位的 body 副本，不修改原对象
 */
const externalizeImages = (body: any): any => {
  if (!body || !Array.isArray(body.messages)) return body;
  const messages = body.messages.map((msg: any) => {
    if (!Array.isArray(msg?.content)) return msg;
    const content = msg.content.map((block: any) => {
      if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string') {
        return { ...block, source: { ...block.source, data: saveImage(block.source.data, block.source.media_type) } };
      }
      if (block?.type === 'image_url' && typeof block.image_url?.url === 'string' && block.image_url.url.startsWith('data:')) {
        const m = block.image_url.url.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) {
          return { ...block, image_url: { ...block.image_url, url: saveImage(m[2], m[1]) } };
        }
      }
      return block;
    });
    return { ...msg, content };
  });
  return { ...body, messages };
};

/**
 * 删除 images 目录下没有被任何现存日志引用的图片
 * 日志列表在归档后重新读取，归档期间新建的会话日志也会被扫到
 * @param cleanupStart 本轮清理开始时间，在此之后写入或被重新引用（mtime 刷新）的图片不删
 */
const cleanupOrphanImages = async (cleanupStart: number): Promise<void> => {
  try {
    const imagesDir = getImagesDir();
    if (!fs.existsSync(imagesDir)) return;

    const llmLogsDir = getLLMLogsDir();
    const logFiles = fs.readdirSync(llmLogsDir)
      .filter(file => file.endsWith('.log'))
      .map(file => path.join(llmLogsDir, file));

    const referenced = new Set<string>();
    for (const filePath of logFiles) {
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity
      });
      for await (const line of rl) {
        for (const m of line.matchAll(IMAGE_REF_RE)) {
          referenced.add(m[1]);
        }
      }
    }

    for (const name of fs.readdirSync(imagesDir)) {
      const hash = name.split('.')[0];
      if (referenced.has(hash)) continue;
      const imagePath = path.join(imagesDir, name);
      try {
        // 清理开始后写入或重新引用的图片，其日志行可能还没扫到，这轮先不删
        if (fs.statSync(imagePath).mtimeMs >= cleanupStart) continue;
        fs.unlinkSync(imagePath);
      } catch (err) {
      }
    }
  } catch (err) {
    logError(`清理LLM日志图片出错: ${err}`);
  }
};

/**
 * 记录LLM请求body到专门的日志文件
 * 格式: [HH:MM:SS]${body}
 */
export const logLLMRequest = (body: any, sessionId?: string): void => {
  try {
    const timeStr = getTimeString(); // 使用时分秒格式

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(externalizeImages(body));
    const logLine = `[${timeStr}]${bodyStr}`;

    const logFilePath = getLLMLogFilePath(sessionId);
    fs.appendFileSync(logFilePath, logLine + '\n', 'utf8');

    // 定时清理LLM日志文件（每小时最多执行一次）
    const nowTimestamp = nowMillis();
    if (nowTimestamp - lastLLMCleanupTime > LLM_LOG_CLEANUP_INTERVAL) {
      lastLLMCleanupTime = nowTimestamp;
      // 异步执行清理，避免阻塞日志写入
      setImmediate(() => {
        void cleanupLLMLogFiles();
      });
    }
  } catch (err) {
    logError(err);
  }
};

/**
 * 记录LLM响应到专门的日志文件
 * 格式: [HH:MM:SS]${response}
 */
export const logLLMResponse = (assistantMessage: any, sessionId?: string): void => {
  try {
    const timeStr = getTimeString(); // 使用时分秒格式

    // 从AiMessage中提取文本内容
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

    // 从AiMessage中提取工具调用
    const toolCalls = contentBlocks
      .filter((block: any) => block.type === 'tool_use')
      .map((block: any) => ({
        name: block.name,
        args: block.input
      }));

    const responseData = {
      content,
      ...(toolCalls.length > 0 && { toolCalls }),
      ...(thinking && { thinking })
    };

    const logLine = `[${timeStr}]${JSON.stringify(responseData)}`;

    const logFilePath = getLLMLogFilePath(sessionId);
    fs.appendFileSync(logFilePath, logLine + '\n', 'utf8');

    // 定时清理LLM日志文件（每小时最多执行一次）
    const nowTimestamp = nowMillis();
    if (nowTimestamp - lastLLMCleanupTime > LLM_LOG_CLEANUP_INTERVAL) {
      lastLLMCleanupTime = nowTimestamp;
      // 异步执行清理，避免阻塞日志写入
      setImmediate(() => {
        void cleanupLLMLogFiles();
      });
    }
  } catch (err) {
    logError(err);
  }
};

/**
 * 归档时把消息里的图片 base64 换成占位，只影响 tracks 归档文件，不影响 llm_logs 原文件
 */
const stripImageData = (messages: any[]): any[] => {
  return messages.map((msg: any) => {
    if (!Array.isArray(msg?.content)) return msg;
    const content = msg.content.map((block: any) => {
      if (block?.type === 'image' && typeof block.source?.data === 'string' && !block.source.data.startsWith('<image ')) {
        return { ...block, source: { ...block.source, data: `<image ${block.source.data.length} bytes>` } };
      }
      if (block?.type === 'image_url' && typeof block.image_url?.url === 'string' && block.image_url.url.startsWith('data:')) {
        return { ...block, image_url: { ...block.image_url, url: `<image ${block.image_url.url.length} bytes>` } };
      }
      return block;
    });
    return { ...msg, content };
  });
};

/**
 * 流式逐行读取LLM日志，提取messages最长的请求及其后续响应
 * 不整文件读入内存，避免超大文件撞上字符串长度上限
 */
const extractLongestLLMConversation = async (filePath: string): Promise<string> => {
  let longestRequest: { timestamp: string; line: string } | null = null;
  let maxLength = 0;
  let nextResponseLine: string | null = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const match = line.match(/^\[(\d{2}:\d{2}:\d{2})\](.+)$/);
      if (!match) continue;

      const jsonData = JSON.parse(match[2]);
      const isRequest = !!jsonData.messages;

      if (isRequest) {
        if (jsonData.messages.length > maxLength) {
          maxLength = jsonData.messages.length;
          longestRequest = { timestamp: match[1], line: match[2] };
          nextResponseLine = null;
        }
      } else if (longestRequest && nextResponseLine === null) {
        nextResponseLine = line;
      }
    } catch (err) {
      // 解析失败，跳过
      continue;
    }
  }

  if (!longestRequest) {
    return '';
  }

  // 构建结果
  const resultLines: string[] = [];
  const projectName = getProjectName();

  // 处理请求：只保留model和messages字段，过滤系统消息，图片 base64 换占位
  const requestData = JSON.parse(longestRequest.line);
  const filteredMessages = stripImageData(requestData.messages.filter((msg: any) => msg.role !== 'system'));
  if (filteredMessages.length > 0) {
    const filteredRequest = {
      model: requestData.model,
      messages: filteredMessages
    };
    resultLines.push(`[${longestRequest.timestamp}][${projectName}]${JSON.stringify(filteredRequest)}`);
  }

  // 添加响应（如果存在）
  if (nextResponseLine) {
    resultLines.push(nextResponseLine);
  }

  return resultLines.join('\n');
};

/**
 * 将LLM日志文件归档到tracks目录
 */
const archiveLLMLogFiles = async (filesToArchive: Array<{name: string, path: string, mtime: Date}>): Promise<void> => {
  try {
    const tracksDir = getTracksDir();

    // 确保tracks目录存在
    if (!fs.existsSync(tracksDir)) {
      fs.mkdirSync(tracksDir, { recursive: true });
    }

    for (const file of filesToArchive) {
      try {
        // 流式提取最长对话内容
        const extractedContent = await extractLongestLLMConversation(file.path);

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
const cleanupLLMLogFiles = async (): Promise<void> => {
  try {
    const llmLogsDir = getLLMLogsDir();
    if (!fs.existsSync(llmLogsDir)) {
      return;
    }

    // 在读目录快照之前取时间，归档期间新写入的图片才能落在保护窗口内
    const cleanupStart = Date.now();

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
      await archiveLLMLogFiles(filesToArchive);
    }

    // 归档后按现存日志的引用清理孤儿图片
    await cleanupOrphanImages(cleanupStart);
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
const getEventLogFilePath = (sessionId?: string): string => {
  const dateStr = getDayTimeString();
  const eventDir = getEventDir();

  if (!fs.existsSync(eventDir)) {
    fs.mkdirSync(eventDir, { recursive: true });
  }

  // 有 sessionId 时按会话拆分日志文件
  const filename = sessionId ? `${dateStr}_${sessionId}.log` : `${dateStr}.log`;
  return path.join(eventDir, filename);
};

/**
 * 记录事件到日志文件
 * 格式: [HH:MM:SS]${event}|${data}
 */
export const logEvent = (event: string, data: any, sessionId?: string): void => {
  try {
    const timeStr = getTimeString();
    const dataStr = data !== undefined ? JSON.stringify(data) : '';
    const logLine = `[${timeStr}]${event}|${dataStr}`;

    const logFilePath = getEventLogFilePath(sessionId);
    fs.appendFileSync(logFilePath, logLine + '\n', 'utf8');

    // 定时清理事件日志文件
    const nowTimestamp = nowMillis();
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
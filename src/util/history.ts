import { Message } from '../types/message';
import { TodoItem } from '../events/types';
import { logDebug, logInfo, logWarn } from './log';
import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir, getHistoryFilePath, getProjectHistoryDir } from './savePath';
import {
  PER_PROJECT_HISTORY_LENGTH_LIMIT,
  PROJECT_LENGTH_LIMIT,
  HISTORY_CLEANUP_INTERVAL
} from '../constants/config';
import { getCurrentTimestamp } from './time';
import { SYNTHETIC_ASSISTANT_MESSAGES } from '../constants/message';

// 清理历史文件的时间间隔（毫秒）
let lastHistoryCleanupTime: number = 0;

// 历史数据结构
interface HistoryData {
  messages: Message[];
  todos: TodoItem[];
}

/**
 * 判断一条 assistant 消息是否包含有效 usage
 */
function hasValidUsage(message: Message): boolean {
  if (message.type !== 'assistant' || !('usage' in message.message)) return false;
  // 排除合成消息
  if (
    message.message.content[0]?.type === 'text' &&
    SYNTHETIC_ASSISTANT_MESSAGES.has(message.message.content[0].text)
  ) return false;
  const usage = message.message.usage as any;
  if (!usage || typeof usage !== 'object') return false;
  return ('input_tokens' in usage && 'output_tokens' in usage) ||
    ('prompt_tokens' in usage && 'completion_tokens' in usage);
}

/**
 * 剥离多余的 usage，只保留最后一条有效 usage 的消息
 */
function stripRedundantUsage(messages: Message[]): Message[] {
  // 从后往前找到最后一条有效 usage 的索引
  let lastUsageIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasValidUsage(messages[i])) {
      lastUsageIndex = i;
      break;
    }
  }

  return messages.map((msg, index) => {
    if (index === lastUsageIndex) return msg;
    if (msg.type === 'assistant' && 'usage' in msg.message) {
      const { usage, ...rest } = msg.message as any;
      return { ...msg, message: rest };
    }
    return msg;
  });
}

/**
 * 加载历史消息和todos
 * @param sessionId 会话ID
 * @param projectPath 项目绝对路径
 */
export async function loadHistory(sessionId?: string, projectPath?: string): Promise<HistoryData> {
  if (!sessionId) return { messages: [], todos: [] };

  const historyPath = getHistoryFilePath(sessionId, projectPath);

  try {
    if (fs.existsSync(historyPath)) {
      const historyData: HistoryData = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      const messages = historyData.messages || [];
      const todos = historyData.todos || [];
      logInfo(`加载历史消息 ${messages.length} 条，todos ${todos.length} 项`);
      return { messages, todos };
    } else {
      logInfo(`未找到历史文件: ${historyPath}，开始新会话`);
      return { messages: [], todos: [] };
    }
  } catch (error) {
    logWarn(`加载历史失败: ${error instanceof Error ? error.message : String(error)}`);
    return { messages: [], todos: [] };
  }
}

/**
 * 清理指定项目目录下的旧历史文件，只保留最新的指定数量
 * @param projectHistoryDir 项目历史目录路径
 */
function cleanupProjectHistoryFiles(projectHistoryDir: string): void {
  try {
    if (!fs.existsSync(projectHistoryDir)) {
      return;
    }

    const files = fs.readdirSync(projectHistoryDir);
    const historyFiles = files.filter(file =>
      file.endsWith('.json') && /^\d{4}-\d{2}-\d{2}_.+\.json$/.test(file)
    );

    if (historyFiles.length <= PER_PROJECT_HISTORY_LENGTH_LIMIT) {
      return;
    }

    const filesWithStats = historyFiles.map(file => {
      const filePath = path.join(projectHistoryDir, file);
      const stats = fs.statSync(filePath);
      return { name: file, path: filePath, mtime: stats.mtime };
    });

    filesWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const filesToDelete = filesWithStats.slice(PER_PROJECT_HISTORY_LENGTH_LIMIT);

    for (const file of filesToDelete) {
      try {
        fs.unlinkSync(file.path);
        logDebug(`删除旧历史文件: ${file.name}`);
      } catch (deleteError) {
        logWarn(`删除历史文件失败 ${file.name}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
      }
    }

    if (filesToDelete.length > 0) {
      logDebug(`项目清理完成，删除了 ${filesToDelete.length} 个旧历史文件`);
    }
  } catch (error) {
    logWarn(`清理项目历史文件失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 清理不活跃的项目目录，只保留最新的指定数量
 */
function cleanupInactiveProjects(): void {
  const historyDir = getHistoryDir();

  try {
    if (!fs.existsSync(historyDir)) {
      return;
    }

    const entries = fs.readdirSync(historyDir, { withFileTypes: true });
    const projectDirs = entries.filter(entry =>
      entry.isDirectory() && entry.name.startsWith('-')
    );

    if (projectDirs.length <= PROJECT_LENGTH_LIMIT) {
      return;
    }

    // 获取每个项目目录的最新文件修改时间
    const dirsWithStats = projectDirs.map(dir => {
      const dirPath = path.join(historyDir, dir.name);
      let latestMtime = new Date(0);

      try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const stats = fs.statSync(path.join(dirPath, file));
            if (stats.mtime > latestMtime) {
              latestMtime = stats.mtime;
            }
          }
        }
      } catch {
        // 读取失败使用最早时间
      }

      return { name: dir.name, path: dirPath, mtime: latestMtime };
    });

    dirsWithStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    const dirsToDelete = dirsWithStats.slice(PROJECT_LENGTH_LIMIT);

    for (const dir of dirsToDelete) {
      try {
        fs.rmSync(dir.path, { recursive: true, force: true });
        logDebug(`删除不活跃项目历史目录: ${dir.name}`);
      } catch (deleteError) {
        logWarn(`删除项目历史目录失败 ${dir.name}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
      }
    }

    if (dirsToDelete.length > 0) {
      logDebug(`项目目录清理完成，删除了 ${dirsToDelete.length} 个不活跃项目`);
    }
  } catch (error) {
    logWarn(`清理项目目录失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 清理旧的历史文件
 * @param projectPath 项目绝对路径（可选）
 */
export async function cleanupOldHistoryFiles(projectPath?: string): Promise<void> {
  if (projectPath) {
    cleanupProjectHistoryFiles(getProjectHistoryDir(projectPath));
  }
  cleanupInactiveProjects();
}

/**
 * 保存历史消息和todos
 * @param sessionId 会话ID
 * @param messages 消息列表
 * @param todos Todo列表
 * @param projectPath 项目绝对路径
 */
export async function saveHistory(sessionId: string, messages: Message[], todos?: TodoItem[], projectPath?: string): Promise<void> {
  const historyDir = projectPath ? getProjectHistoryDir(projectPath) : getHistoryDir();
  const historyPath = getHistoryFilePath(sessionId, projectPath);

  try {
    // 确保目录存在
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }

    const historyData: HistoryData = {
      messages: stripRedundantUsage(messages),
      todos: todos || []
    };

    fs.writeFileSync(historyPath, JSON.stringify(historyData, null, 2));
    logInfo(`保存历史消息 ${messages.length} 条，todos ${(todos || []).length} 项到 ${historyPath}`);

    // 定时清理历史文件（每小时最多执行一次）
    const nowTimestamp = getCurrentTimestamp();
    if (nowTimestamp - lastHistoryCleanupTime > HISTORY_CLEANUP_INTERVAL) {
      lastHistoryCleanupTime = nowTimestamp;
      setImmediate(() => {
        cleanupOldHistoryFiles(projectPath);
      });
    }

  } catch (error) {
    logWarn(`保存历史失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// 导出类型
export type { HistoryData };
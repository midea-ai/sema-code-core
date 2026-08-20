import { Message } from '../types/message';
import { TodoItem } from '../events/types';
import { TodoTask } from '../types/todoTask';
import { logDebug, logInfo, logWarn } from './log';
import * as fs from 'fs';
import * as path from 'path';
import { getHistoryDir, getHistoryFilePath, getProjectHistoryDir, getProjectSnapshotsDir, getSnapshotsDir } from './savePath';
import { cleanupProjectSnapshots } from './snapshotStore';
import {
  PER_PROJECT_HISTORY_LENGTH_LIMIT,
  PROJECT_LENGTH_LIMIT,
  HISTORY_CLEANUP_INTERVAL
} from '../conf/config';
import { nowMillis } from './time';

// 清理历史文件的时间间隔（毫秒）
let lastHistoryCleanupTime: number = 0;

// 历史数据结构
interface HistoryData {
  messages: Message[];
  todos: TodoItem[];
  todoTasks?: TodoTask[];
  readFileTimestamps?: Record<string, number>;
}

/**
 * 解析会话当前应使用的历史文件路径与命名格式。
 * 优先级：无日期 会话id.json > 当天带日期 日期_会话id.json > 目录扫描任意日期 日期_会话id.json（跨天恢复）。
 * 都不存在时返回当天带日期路径，exists=false（由调用方决定新会话的命名格式）。
 */
export function resolveHistoryFile(sessionId: string, projectPath?: string): { path: string; noDate: boolean; exists: boolean } {
  const noDatePath = getHistoryFilePath(sessionId, projectPath, true);
  if (fs.existsSync(noDatePath)) return { path: noDatePath, noDate: true, exists: true };

  const datedPath = getHistoryFilePath(sessionId, projectPath, false);
  if (fs.existsSync(datedPath)) return { path: datedPath, noDate: false, exists: true };

  // 带日期文件的日期是创建当天的，跨天恢复时上面拼"今天"必然落空，需扫描目录匹配任意日期
  const historyDir = projectPath ? getProjectHistoryDir(projectPath) : getHistoryDir();
  try {
    // 文件名固定为 YYYY-MM-DD_会话id.json（前缀 11 字符），用字符串比较而非拼正则，兼容含特殊字符的会话 id
    const candidates = fs.readdirSync(historyDir).filter(file =>
      /^\d{4}-\d{2}-\d{2}_/.test(file) && file.slice(11) === `${sessionId}.json`
    );
    if (candidates.length > 0) {
      const latest = candidates
        .map(file => {
          const filePath = path.join(historyDir, file);
          return { path: filePath, mtime: fs.statSync(filePath).mtime.getTime() };
        })
        .sort((a, b) => b.mtime - a.mtime)[0];
      return { path: latest.path, noDate: false, exists: true };
    }
  } catch {
    // 目录不存在或读取失败，按未命中处理
  }

  return { path: datedPath, noDate: false, exists: false };
}

/**
 * 加载历史消息和todos
 */
export async function loadHistory(sessionId?: string, projectPath?: string): Promise<HistoryData> {
  if (!sessionId) return { messages: [], todos: [] };

  const { path: historyPath, exists } = resolveHistoryFile(sessionId, projectPath);

  try {
    if (exists) {
      const historyData: HistoryData = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      const messages = historyData.messages || [];
      const todos = historyData.todos || [];
      const todoTasks = historyData.todoTasks || [];
      const readFileTimestamps = historyData.readFileTimestamps || {};
      logInfo(`加载历史消息 ${messages.length} 条，todos ${todos.length} 项，todoTasks ${todoTasks.length} 项，readFileTimestamps ${Object.keys(readFileTimestamps).length} 项`);
      return { messages, todos, todoTasks, readFileTimestamps };
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

      // 同步删除对应的同名快照目录，避免遗留无主 editlog / blob
      // （snapshots 与 history 共用项目目录名，仅根目录不同）
      const snapshotDir = path.join(getSnapshotsDir(), dir.name);
      try {
        if (fs.existsSync(snapshotDir)) {
          fs.rmSync(snapshotDir, { recursive: true, force: true });
          logDebug(`删除不活跃项目快照目录: ${dir.name}`);
        }
      } catch (deleteError) {
        logWarn(`删除项目快照目录失败 ${dir.name}: ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
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
 */
export async function cleanupOldHistoryFiles(projectPath?: string): Promise<void> {
  if (projectPath) {
    cleanupProjectHistoryFiles(getProjectHistoryDir(projectPath));
    // 历史清理后回收对应快照（删除无主 editlog + blob 标记清除）
    cleanupProjectSnapshots(projectPath);
  }
  cleanupInactiveProjects();
}

/**
 * 删除指定项目的全部历史与快照目录（~/.sema/history/<项目目录名> + ~/.sema/snapshots/<项目目录名>）。
 * 供外部（如 webui 会话级项目退场）主动清理使用。
 */
export function deleteProjectHistory(projectPath: string): void {
  const targets = [
    { dir: getProjectHistoryDir(projectPath), root: getHistoryDir(), label: '历史' },
    { dir: getProjectSnapshotsDir(projectPath), root: getSnapshotsDir(), label: '快照' }
  ];
  for (const { dir, root, label } of targets) {
    // 护栏：目标必须严格位于对应根目录之内，防止异常路径误删
    const rel = path.relative(root, dir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      logWarn(`删除项目${label}目录被拒绝（路径越界）: ${dir}`);
      continue;
    }
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        logInfo(`删除项目${label}目录: ${dir}`);
      }
    } catch (error) {
      logWarn(`删除项目${label}目录失败 ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * 删除单个会话的历史文件（无日期 会话id.json 与任意日期 日期_会话id.json 全部清理）。
 * 供外部（如 webui 项目内会话退场）主动清理使用。
 */
export function deleteSessionHistory(sessionId: string, projectPath?: string): void {
  const historyDir = projectPath ? getProjectHistoryDir(projectPath) : getHistoryDir();
  try {
    if (!fs.existsSync(historyDir)) return;
    const targets = fs.readdirSync(historyDir).filter(file =>
      file === `${sessionId}.json` ||
      (/^\d{4}-\d{2}-\d{2}_/.test(file) && file.slice(11) === `${sessionId}.json`)
    );
    for (const file of targets) {
      try {
        fs.unlinkSync(path.join(historyDir, file));
        logInfo(`删除会话历史文件: ${file}`);
      } catch (error) {
        logWarn(`删除会话历史文件失败 ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    logWarn(`删除会话历史失败 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 保存历史消息和todos
 */
export async function saveHistory(sessionId: string, messages: Message[], todos?: TodoItem[], projectPath?: string, readFileTimestamps?: Record<string, number>, todoTasks?: TodoTask[], noDate?: boolean): Promise<void> {
  const historyDir = projectPath ? getProjectHistoryDir(projectPath) : getHistoryDir();
  // 已有历史文件时写回原文件（旧日期文件跨天/跨零点继续沿用，不按今天日期另起新文件），
  // 不存在时才按 noDate 决定新文件命名格式
  const resolved = resolveHistoryFile(sessionId, projectPath);
  const historyPath = resolved.exists ? resolved.path : getHistoryFilePath(sessionId, projectPath, noDate);

  try {
    // 确保目录存在
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }

    const historyData: HistoryData = {
      messages,
      todos: todos || [],
      ...(todoTasks && todoTasks.length > 0 && { todoTasks }),
      ...(readFileTimestamps && Object.keys(readFileTimestamps).length > 0 && { readFileTimestamps })
    };

    fs.writeFileSync(historyPath, JSON.stringify(historyData, null, 2));
    logInfo(`保存历史消息 ${messages.length} 条，todos ${(todos || []).length} 项，readFileTimestamps ${Object.keys(readFileTimestamps || {}).length} 项到 ${historyPath}`);

    // 定时清理历史文件（每小时最多执行一次）
    const nowTimestamp = nowMillis();
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
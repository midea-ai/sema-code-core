import * as crypto from 'crypto';
import * as path from 'path';
import { getDayTimeString } from './time';
import { getHistoryFilePath } from './savePath';

/**
 * 会话管理工具函数
 */

/**
 * 从历史路径中解析 sessionId
 * 历史路径格式: ~/.sema/history/2025-01-01_{sessionId}.json
 * @param historyPath 历史文件路径
 * @returns sessionId 或 null（如果解析失败）
 */
export function parseSessionIdFromHistoryPath(historyPath: string): string | null {
  try {
    const fileName = path.basename(historyPath, '.json');
    const underscoreIndex = fileName.lastIndexOf('_');
    if (underscoreIndex === -1) {
      return null;
    }
    const sessionId = fileName.substring(underscoreIndex + 1);

    // 验证 sessionId 格式（8位短 UUID 格式）
    const shortIdRegex = /^[0-9a-f]{8}$/i;

    if (!shortIdRegex.test(sessionId)) {
      return null;
    }

    return sessionId;
  } catch (error) {
    return null;
  }
}

/**
 * 生成新的 sessionId
 * @returns 新的短 UUID 格式的 sessionId（8位）
 */
export function generateSessionId(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 8);
}

/**
 * 初始化 sessionId
 * 如果提供了 historyPath 且能成功解析出 sessionId，则使用解析出的 sessionId
 * 否则生成新的 sessionId
 * @param historyPath 可选的历史文件路径
 * @returns sessionId
 */
export function initializeSessionId(historyPath?: string): string {
  if (historyPath) {
    const parsedSessionId = parseSessionIdFromHistoryPath(historyPath);
    if (parsedSessionId) {
      return parsedSessionId;
    }
  }

  return generateSessionId();
}

/**
 * 验证 sessionId 格式
 * @param sessionId 要验证的 sessionId
 * @returns 是否为有效的短 UUID 格式
 */
export function validateSessionId(sessionId: string): boolean {
  const shortIdRegex = /^[0-9a-f]{8}$/i;
  return shortIdRegex.test(sessionId);
}

/**
 * 根据 sessionId 生成历史文件路径
 * @param sessionId 会话ID
 * @param baseDir 基础目录，默认使用 path.ts 中的统一配置
 * @returns 历史文件路径
 */
export function generateHistoryPath(sessionId: string, baseDir?: string): string {
  if (baseDir) {
    const today = getDayTimeString(); // YYYY-MM-DD 格式
    const fileName = `${today}_${sessionId}.json`;
    return path.join(baseDir, fileName);
  }

  // 使用 path.ts 中统一的路径获取函数
  return getHistoryFilePath(sessionId);
}
import * as crypto from 'crypto';
import * as path from 'path';
import { getDayTimeString } from './time';
import { getHistoryFilePath } from './savePath';

/**
 * 会话管理工具函数
 */

/**
 * 生成 8 位十六进制短 ID
 */
export function generateShortId(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 8);
}

/**
 * 生成新的 sessionId
 */
export function generateSessionId(): string {
  return generateShortId();
}

/**
 * 验证 sessionId 格式
 */
export function validateSessionId(sessionId: string): boolean {
  const shortIdRegex = /^[0-9a-f]{8}$/i;
  return shortIdRegex.test(sessionId);
}

/**
 * 根据 sessionId 生成历史文件路径
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
import { getOriginalCwd, getCwd } from './cwd';
import { isAbsolute, resolve, relative } from 'path';

/**
 * 文件权限相关工具函数
 */

/**
 * 检查文件是否在授权范围内（项目根目录下）
 */
export function isFileInAuthorizedScope(filePath: string): boolean {
  const absolutePath = toAbsolutePath(filePath);
  const normalizedRoot = normalize(getOriginalCwd());
  const normalizedFile = normalize(absolutePath);
  return isSubpath(normalizedRoot, normalizedFile);
}

/**
 * 获取文件路径（从工具输入中）
 */
export function getFilePath(input: { [key: string]: unknown }): string | undefined {
  return (input as any).file_path || (input as any).notebook_path;
}

/**
 * 转换为绝对路径
 */
function toAbsolutePath(path: string): string {
  return normalize(isAbsolute(path) ? path : resolve(getCwd(), path));
}

/**
 * 规范化路径
 */
function normalize(p: string): string {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 检查目标路径是否为基础路径的子路径
 */
function isSubpath(base: string, target: string): boolean {
  const rel = relative(base, target);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}
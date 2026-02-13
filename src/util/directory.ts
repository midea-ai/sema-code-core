import * as fs from 'fs';
import * as path from 'path';

/**
 * 工作目录验证结果
 */
export interface DirectoryValidationResult {
  exists: boolean;
  readable: boolean;
  writable: boolean;
  absolutePath: string;
}

/**
 * 验证工作目录是否存在且有正确权限
 */
export function validateWorkingDirectory(workingDir: string): DirectoryValidationResult {
  const absolutePath = path.resolve(workingDir);

  const result: DirectoryValidationResult = {
    exists: false,
    readable: false,
    writable: false,
    absolutePath
  };

  // 检查目录是否存在
  if (!fs.existsSync(absolutePath)) {
    return result;
  }

  result.exists = true;

  // 验证目录权限
  try {
    // 检查读权限
    fs.accessSync(absolutePath, fs.constants.R_OK);
    result.readable = true;
  } catch {
    // 读权限不足
  }

  try {
    // 检查写权限
    fs.accessSync(absolutePath, fs.constants.W_OK);
    result.writable = true;
  } catch {
    // 写权限不足
  }

  return result;
}

/**
 * 确保工作目录有效（存在且有读写权限）
 * @throws Error 如果目录不存在或权限不足
 */
export function ensureValidWorkingDirectory(workingDir: string): void {
  const validation = validateWorkingDirectory(workingDir);

  if (!validation.exists) {
    throw new Error(`工作目录不存在: ${validation.absolutePath}`);
  }

  if (!validation.readable) {
    throw new Error(`工作目录没有读权限: ${validation.absolutePath}`);
  }

  if (!validation.writable) {
    throw new Error(`工作目录没有写权限: ${validation.absolutePath}`);
  }
}

/**
 * 获取目录的统计信息
 */
export function getDirectoryStats(dirPath: string) {
  try {
    const stats = fs.statSync(dirPath);
    return {
      isDirectory: stats.isDirectory(),
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime
    };
  } catch (error) {
    throw new Error(`无法获取目录统计信息: ${dirPath}`);
  }
}

/**
 * 检查目录是否为空
 */
export function isDirectoryEmpty(dirPath: string): boolean {
  try {
    const files = fs.readdirSync(dirPath);
    return files.length === 0;
  } catch (error) {
    throw new Error(`无法读取目录内容: ${dirPath}`);
  }
}

/**
 * 安全地创建目录（如果不存在）
 */
export function ensureDirectoryExists(dirPath: string): void {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch (error) {
    throw new Error(`无法创建目录: ${dirPath}`);
  }
}
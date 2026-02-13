import { PersistentShell } from './shell'
import { cwd } from 'process'
import { logInfo } from './log'
import { normalizeFilePath } from './file'

/**
 * 设置当前工作目录（动态变化，会随着shell目录切换而更新）
 *
 * 使用场景：
 * - Bash 目录切换：处理 cd 命令时更新当前目录
 * - 文件操作基准：为文件搜索、编辑等操作提供当前工作目录
 * - 路径解析：解析相对路径时使用当前目录作为基准
 *
 * @param cwd 要设置的工作目录路径
 */
export async function setCwd(cwd: string): Promise<void> {
  // 强制重新初始化 PersistentShell 实例以确保工作目录变更被感知
  PersistentShell.restart();

  await PersistentShell.getInstance().setCwd(cwd);
  let actualCwd = PersistentShell.getInstance().pwd();

  // Windows平台下使用 normalizeFilePath 标准化路径显示
  if (process.platform === 'win32') {
    actualCwd = normalizeFilePath(actualCwd);
  }

  logInfo(`[setCwd] 工作目录切换完成，实际目录: ${actualCwd}`);
}

/**
 * 获取当前工作目录（返回PersistentShell实例的当前目录，动态变化）
 *
 * 使用场景：
 * - 文件操作：GlobTool和GrepTool等工具进行文件搜索时
 * - 路径解析：文件编辑工具解析相对路径时
 * - 代码风格检测：查找项目配置文件时
 * - 命令执行：执行shell命令时的工作目录
 *
 * @returns 当前工作目录路径（Windows平台下自动标准化Unix风格路径）
 */
export function getCwd(): string {
  const currentPath = PersistentShell.getInstance().pwd()

  // Windows平台下使用 normalizeFilePath 统一标准化路径
  if (process.platform === 'win32') {
    return normalizeFilePath(currentPath)
  }

  return currentPath
}

const STATE: {
  originalCwd: string
} = {
  originalCwd: cwd(),
}

/**
 * 设置原始工作目录（静态值，一旦设置就不会改变）
 *
 * 使用场景：
 * - core启动时设置：当使用 workingDir 参数时，同时设置原始和当前目录
 *
 * @param cwd 要设置的原始工作目录路径
 */
export function setOriginalCwd(cwd: string): void {
  // Windows 平台下标准化路径（处理 /c/Users/... 格式）
  if (process.platform === 'win32') {
    STATE.originalCwd = normalizeFilePath(cwd)
  } else {
    STATE.originalCwd = cwd
  }
}

/**
 * 获取原始工作目录（返回进程启动时的工作目录，存储在全局状态中）
 *
 * 使用场景：
 * - 重置操作：在 /clear 命令中重置到启动目录
 * - 项目标识：显示项目信息时使用原始目录
 * - 权限上下文：在权限选项中显示当前工作目录
 *
 * @returns 原始工作目录路径
 */
export function getOriginalCwd(): string {
  return STATE.originalCwd
}

/**
 * Sema 落盘根目录单一真源：复用 sema-core 的 SemaCore.getSemaRootDir()（SEMA_ROOT 环境变量，缺省 ~/.sema，跨 Win/macOS/Linux）。
 * webui 自身的运行产物（注册表、快照、token、错误/性能日志等）统一落在 <semaRoot>/webui。
 */
import path from 'path';
import { SemaCore } from 'sema-core';

export function getSemaRootDir(): string {
  return SemaCore.getSemaRootDir();
}

export const SEMA_ROOT_DIR = getSemaRootDir();
export const WEBUI_HOME = path.join(SEMA_ROOT_DIR, 'webui');

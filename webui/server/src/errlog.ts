/**
 * 宿主错误日志：~/.sema/webui/error.log。
 * 终端只留用户必读的几句（已启动 / 正在关闭 / 启动失败等），server 内部的错误与进程级兜底异常都写到这里；
 * 每次启动清空重建（initErrorLog），不跨次累积。core 自身的日志另在 ~/.sema/logs/，worker 的 stdout/stderr 由 pool 直接丢弃。
 * 三个宿主共用：index.ts / webui/cli 在 startServer 前 init；桌面版由主进程 init（先于 fork server 进程），server-host 只追加。
 * 同步写，进程崩溃前能落盘；写失败静默，日志不能反过来把服务弄挂。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 与 registry.ts 的 WEBUI_HOME 同目录；这里不引 registry，桌面版主进程也要用 */
export const ERROR_LOG = path.join(os.homedir(), '.sema', 'webui', 'error.log');

/** 清空并写启动头；每个宿主进程生命周期调一次 */
export function initErrorLog(host: string, version?: string): void {
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true });
    fs.writeFileSync(ERROR_LOG, `[${new Date().toISOString()}] [${host}] started pid=${process.pid}${version ? ` version=${version}` : ''}\n`);
  } catch { /* ignore */ }
}

function fmt(v: unknown): string {
  if (v instanceof Error) return v.stack || v.message;
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/** 追加一行：[时间] [tag] 内容；Error 带堆栈 */
export function logErr(tag: string, ...args: unknown[]): void {
  try { fs.appendFileSync(ERROR_LOG, `[${new Date().toISOString()}] [${tag}] ${args.map(fmt).join(' ')}\n`); } catch { /* ignore */ }
}

/** 进程级兜底：漏掉的异步异常只记日志，不让整个服务（含所有 worker/终端）崩掉 */
export function installProcessTraps(tag: string): void {
  process.on('uncaughtException', (err) => logErr(tag, 'uncaughtException:', err));
  process.on('unhandledRejection', (reason) => logErr(tag, 'unhandledRejection:', reason));
}

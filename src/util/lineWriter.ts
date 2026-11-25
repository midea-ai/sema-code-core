/**
 * 按行追加日志的异步写入器：入队后下一个事件循环批量 append，避免每条事件 / 日志都同步写盘。
 * - 同一文件的连续写入合并成一次 appendFileSync，顺序不变
 * - 进程退出（exit）时同步把队列写完；SemaCore.dispose 通过 flushLinesSync 显式收口
 * - 写失败时补建目录重试一次，仍失败丢弃这一批（日志不能反过来影响主流程）
 */

import * as fs from 'fs';
import * as path from 'path';

interface PendingBatch {
  file: string;
  text: string;
}

let pending: PendingBatch[] = [];
let scheduled = false;
let exitHookInstalled = false;

/** 入队一行（line 需自带换行符） */
export function appendLine(file: string, line: string): void {
  const last = pending[pending.length - 1];
  if (last && last.file === file) {
    last.text += line;
  } else {
    pending.push({ file, text: line });
  }
  if (!scheduled) {
    scheduled = true;
    setImmediate(flush);
  }
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', flush);
  }
}

/** 同步写完队列里剩下的内容（dispose / 退出前调用） */
export function flushLinesSync(): void {
  flush();
}

function flush(): void {
  scheduled = false;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  for (const { file, text } of batch) {
    try {
      fs.appendFileSync(file, text, 'utf8');
    } catch {
      // 目录可能被外部删掉（或首次创建失败）：补建后重试一次
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, text, 'utf8');
      } catch {
        // 忽略：写日志失败不影响主流程
      }
    }
  }
}

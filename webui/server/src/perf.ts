/**
 * 性能采样（仅诊断用）：SEMA_WEBUI_PERF=1 时每秒向 ~/.sema/webui/perf.log 追加一行。
 * - 默认关闭：未开启时不创建定时器、不注册采样器，所有调用点都是空操作
 * - 追加而不是每次启动清空：性能问题往往是事后回看，需要出问题前几分钟的曲线
 * - 增长到 5MB 轮转为 perf.log.1，最多两份
 * - 写入异步且串行，避免采样本身抬高事件循环延迟；写失败静默，不能反过来影响服务
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';

const ENABLED = process.env.SEMA_WEBUI_PERF === '1';
const PERF_LOG = path.join(os.homedir(), '.sema', 'webui', 'perf.log');
/** 单文件上限：约等于每秒一行连续跑一天的体积 */
const MAX_BYTES = 5 * 1024 * 1024;
/** 每写多少行检查一次大小（写满 5MB 才轮转，不逐行 stat） */
const ROTATE_CHECK_LINES = 60;
const START = Date.now();

// ==================== 调用点写入的计数器（每秒采样后清零） ====================

let events = 0;
let bytes = 0;
let writeMs = 0;
let writeCount = 0;
let peakHeap = 0;

/** 一个会话事件被应用（ev/s） */
export function perfEvent(): void { if (ENABLED) events++; }

/** WS 出站字节（ws KB/s） */
export function perfBytes(n: number): void { if (ENABLED) bytes += n; }

/** 快照落盘耗时（write 平均耗时 × 次数） */
export function perfWrite(ms: number): void { if (ENABLED) { writeMs += ms; writeCount++; } }

export interface PerfBuffers {
  /** 所有连接待发送字节之和 */
  total: number;
  /** 单连接最大值 */
  max: number;
}

/**
 * 启动采样。buffers 在每次采样时读取每个 WS 连接的待发送字节：
 * 浏览器处理不过来时字节会堆在服务端发送缓冲里，这是从服务端观察前端消费速度的唯一窗口。
 * 返回停止函数。
 */
export function startPerf(buffers: () => PerfBuffers): () => void {
  if (!ENABLED) return () => undefined;

  try { fs.mkdirSync(path.dirname(PERF_LOG), { recursive: true }); } catch { /* ignore */ }
  rotateIfNeeded();
  try {
    fs.appendFileSync(PERF_LOG, `[${new Date().toISOString()}] [perf] started pid=${process.pid}\n`);
  } catch { /* ignore */ }

  // 1ms 分辨率：默认的 10ms 会让正常时的 p50 恒定显示在 10ms 左右，失去参考价值
  const hist: IntervalHistogram = monitorEventLoopDelay({ resolution: 1 });
  hist.enable();

  let pending: string | null = null;
  let writing = false;
  let sinceRotate = 0;

  const flush = () => {
    if (writing || pending === null) return;
    const line = pending;
    pending = null;
    writing = true;
    fs.appendFile(PERF_LOG, line, () => {
      writing = false;
      if (++sinceRotate >= ROTATE_CHECK_LINES) { sinceRotate = 0; rotateIfNeeded(); }
      flush();
    });
  };

  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    peakHeap = Math.max(peakHeap, mem.heapUsed);
    const p50 = (hist.percentile(50) / 1e6).toFixed(1);
    const p99 = (hist.percentile(99) / 1e6).toFixed(1);
    // 单次同步阻塞只贡献一个样本，落在 p99 之外：大文件读盘这类偶发尖刺只能靠 max 看见
    const max = (hist.max / 1e6).toFixed(1);
    hist.reset();
    const buf = buffers();
    const window = { events, bytes, writeMs, writeCount };
    events = 0; bytes = 0; writeMs = 0; writeCount = 0;
    pending = [
      `t=${clock()}`,
      `up=${Math.round((Date.now() - START) / 1000)}s`,
      `evloop=${p50}/${p99}/${max}ms`,
      `heap=${mb(mem.heapUsed)}/${mb(peakHeap)}MB`,
      `rss=${mb(mem.rss)}MB`,
      `ev=${window.events}/s`,
      `ws=${Math.round(window.bytes / 1024)}KB/s`,
      `buf=${Math.round(buf.total / 1024)}/${Math.round(buf.max / 1024)}KB`,
      `write=${window.writeCount ? `${Math.round(window.writeMs / window.writeCount)}ms×${window.writeCount}` : '-'}`,
    ].join(' ') + '\n';
    flush();
  }, 1000);
  timer.unref?.();

  return () => { clearInterval(timer); hist.disable(); };
}

function clock(): string { return new Date().toTimeString().slice(0, 8); }
function mb(n: number): number { return Math.round(n / 1048576); }

/** 超过上限就把当前文件挪成 .1（覆盖旧的），下次写入自动新建 */
function rotateIfNeeded(): void {
  try {
    if (fs.statSync(PERF_LOG).size > MAX_BYTES) fs.renameSync(PERF_LOG, `${PERF_LOG}.1`);
  } catch { /* 不存在或无权限：忽略 */ }
}

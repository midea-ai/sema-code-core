/**
 * SemaWork 命令行入口（网页模式）。
 *   node dist/index.js --port 3210 [--host 127.0.0.1] [--open] [--token xxx]
 * token 优先级 --token > SEMA_WEBUI_TOKEN > ~/.sema/webui/token（首次随机生成后持久化，
 * 重启复用，已打开的页面才能自动重连）。服务本体在 server.ts，桌面版（desktop/）进程内直接调用，
 * npm 包 sema-code-ui（webui/cli/）另有自己的入口，带实例检测与 status/open/stop 子命令。
 */
import { openExternal } from './http/router';
import { startServer, type ServerHandle } from './server';
import { arg, loadOrCreateToken } from './cliUtil';

const port = Number(arg('port', process.env.PORT || '3210'));
const host = arg('host', '127.0.0.1')!;
const token = arg('token') || process.env.SEMA_WEBUI_TOKEN || loadOrCreateToken();
const shouldOpen = arg('open') === 'true';

let handle: ServerHandle | null = null;
let closing = false;
let closingAt = 0;
async function shutdown() {
  if (closing) {
    // npm 等父进程会把终端信号再转发一次，1 秒内的重复信号视为同一次 Ctrl+C，不打断优雅关闭
    if (Date.now() - closingAt < 1000) return;
    console.log('\n再次收到信号，强制退出');
    process.exit(1);
  }
  closing = true;
  closingAt = Date.now();
  console.log('\n正在关闭…');
  await handle?.close();
  process.exit(0);
}
// 兜底：异步回调里漏掉的异常只打日志，不让单个请求的错误把整个服务（含所有会话 worker/终端）拖垮
process.on('uncaughtException', (err) => { console.error('[server] uncaughtException:', err); });
process.on('unhandledRejection', (reason) => { console.error('[server] unhandledRejection:', reason); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

startServer({ port, host, token }).then((h) => {
  handle = h;
  console.log(`\nSemaWork 已启动：${h.url}\n`);
  if (shouldOpen) openExternal(h.url).catch(() => undefined);
}, (e: Error) => {
  console.error(e.message);
  process.exit(1);
});

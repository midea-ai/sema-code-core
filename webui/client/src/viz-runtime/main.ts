/**
 * 可视化页内 runtime：由服务端本地代理注入到 attachments/<uuid>/*.html 的 <head>（见 server.ts serveLocalFile），
 * 在聊天内联 iframe 里跑（不透明源，宿主拿不到页面 DOM）。两件事：
 *   1. 把文档高度与标题 postMessage 给宿主，宿主据此定 iframe 高度与标题；
 *   2. 收到宿主的截图请求时，用 html-to-image 把整页渲染成 png Blob 回传（「复制为图像」）。
 * 独立打包成固定文件名 /viz-runtime.js（vite.config.ts），不与主应用共享代码。不在 iframe 里（直接用浏览器打开）时静默退出。
 */
import { toBlob } from 'html-to-image';
import { VIZ_MSG_TYPE, type VizMessage } from '../../../shared/viz';

if (window.parent !== window) {
  // 不透明源没有可比对的 origin，只能 '*'；消息不含敏感内容
  const post = (msg: VizMessage) => window.parent.postMessage(msg, '*');

  let last = -1;
  const report = () => {
    const doc = document.documentElement;
    const height = Math.ceil(Math.max(doc.scrollHeight, document.body?.scrollHeight || 0));
    if (height === last) return;
    last = height;
    post({ type: VIZ_MSG_TYPE, kind: 'size', height, title: document.title || '' });
  };

  const start = () => {
    report();
    new ResizeObserver(report).observe(document.documentElement);
    if (document.body) new ResizeObserver(report).observe(document.body);
    // 图表库异步初始化 / 字体加载后高度会变，兜底再报几次
    [100, 400, 1200].forEach(ms => setTimeout(report, ms));
    document.fonts?.ready.then(report).catch(() => undefined);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('load', report);

  window.addEventListener('message', async (e: MessageEvent<VizMessage>) => {
    const m = e.data;
    if (!m || m.type !== VIZ_MSG_TYPE || m.kind !== 'snapshot' || 'blob' in m || 'error' in m) return;
    try {
      const blob = await toBlob(document.body, { pixelRatio: 2, backgroundColor: getComputedStyle(document.body).backgroundColor || '#fff', cacheBust: false });
      if (!blob) throw new Error('empty');
      post({ type: VIZ_MSG_TYPE, kind: 'snapshot', id: m.id, blob });
    } catch (err) {
      post({ type: VIZ_MSG_TYPE, kind: 'snapshot', id: m.id, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

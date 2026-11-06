/**
 * 可视化页内 runtime：由服务端本地代理注入到 attachments/<uuid>/*.html 的 <head>（见 server.ts serveLocalFile），
 * 在聊天内联 iframe 里跑（不透明源，宿主拿不到页面 DOM）。三件事：
 *   1. 把文档高度、标题与页面声明的设计宽度 postMessage 给宿主，宿主据此定 iframe 尺寸与标题；
 *   2. 收到宿主的截图请求时，用 html-to-image 把整页渲染成 png Blob 回传（「复制为图像」）；
 *   3. 页面是居中的窄组件样机时，给它铺一层点阵衬底。
 * 独立打包成固定文件名 /viz-runtime.js（vite.config.ts），不与主应用共享代码。不在 iframe 里（直接用浏览器打开）时静默退出。
 */
import { toBlob } from 'html-to-image';
import { VIZ_MSG_TYPE, VIZ_WIDTH_META, type VizMessage } from '../../../shared/viz';

if (window.parent !== window) {
  // 不透明源没有可比对的 origin，只能 '*'；消息不含敏感内容
  const post = (msg: VizMessage) => window.parent.postMessage(msg, '*');

  // 点阵衬底：居中的窄组件（登录框、手机屏幕之类的样机）四周是大片留白，铺一层点阵让它与聊天页面略有区分。
  // 由这里判断并绘制而不是写进页面：已生成的页面也生效，以后调观感不用重新生成；点的颜色取页面主题里的 --grid，随明暗主题变化
  const dotted = document.createElement('style');
  dotted.textContent = 'body.viz-dotted{background-image:radial-gradient(var(--grid,#e1e0d9) 1px,transparent 1px);background-size:18px 18px}';
  (document.head || document.documentElement).appendChild(dotted);

  // 这个点下没有内容：落在 html / body 上，或落在没有底色、边框和文字的纯布局容器上
  const blankAt = (x: number, y: number) => {
    const el = document.elementFromPoint(x, y);
    if (!el || el === document.documentElement || el === document.body) return true;
    if (!el.children.length) return false;
    const s = getComputedStyle(el);
    const painted = s.backgroundImage !== 'none' || !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(s.backgroundColor)
      || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderLeftWidth) > 0;
    const hasText = Array.from(el.childNodes).some(n => n.nodeType === Node.TEXT_NODE && !!n.textContent?.trim());
    return !painted && !hasText;
  };

  // 是不是居中的窄组件：只看宽度，不依赖页面里写了什么——左右两侧各有一条空白，
  // 即在距两边 12% 处沿高度取几个点，点下都没有内容（图表、表格、整页样机都是铺满宽度的，天然不满足）。
  // 宽度变化后结论会变，每次尺寸变化都重判
  const markDotted = () => {
    if (!document.body) return;
    const w = window.innerWidth;
    const h = Math.min(window.innerHeight, document.documentElement.getBoundingClientRect().height);
    const narrow = [0.12, 0.88].every(rx => [0.1, 0.3, 0.5, 0.7, 0.9].every(ry => blankAt(w * rx, h * ry)));
    document.body.classList.toggle('viz-dotted', narrow);
  };

  // 页面声明的设计宽度：宿主据此把内嵌框加宽到消息列以外；未声明或值非法时不带
  const designWidth = () => {
    const v = Number(document.querySelector(`meta[name="${VIZ_WIDTH_META}"]`)?.getAttribute('content'));
    return Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
  };

  let last = -1;
  const report = () => {
    // 取 html 盒子自身的高度：只由内容决定，内容变矮时（宿主把 iframe 拉宽后页面重排）能跟着变小。
    // 不用 scrollHeight：它不会小于视口高度（即 iframe 当前高度），只增不减；宿主在上报值上加的余量还会被它读回来，
    // 宽度变化期间每次重排都再涨一点，越报越高，页面下方留出大片空白
    const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    post({ type: VIZ_MSG_TYPE, kind: 'size', height, title: document.title || '', width: designWidth() });
  };

  const update = () => { markDotted(); report(); };

  const start = () => {
    update();
    new ResizeObserver(update).observe(document.documentElement);
    if (document.body) new ResizeObserver(update).observe(document.body);
    // 图表库异步初始化 / 字体加载后高度会变，兜底再报几次
    [100, 400, 1200].forEach(ms => setTimeout(update, ms));
    document.fonts?.ready.then(update).catch(() => undefined);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('load', update);
  // 宿主改 iframe 尺寸（按上报高度拉高、聊天区变宽变窄）后重判一次点阵
  window.addEventListener('resize', update);

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

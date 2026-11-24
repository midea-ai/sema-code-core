/**
 * 可视化页内 runtime：由服务端本地代理注入到 attachments/<uuid>/*.html 的 <head>（见 server.ts serveLocalFile），
 * 在聊天内联 iframe 里跑（不透明源，宿主拿不到页面 DOM）。三件事：
 *   1. 把文档高度、标题与页面声明的设计宽度 postMessage 给宿主，宿主据此定 iframe 尺寸与标题；
 *   2. 收到宿主的截图请求时，用 html-to-image 把页面渲染成 png Blob 回传（「复制为图像」；
 *      窄组件样机只保留组件本身，四周透明，不带走衬底与留白）；
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
  // 宽度变化后结论会变，每次尺寸变化都重判；点阵与截图共用这一判据
  const isNarrow = () => {
    if (!document.body) return false;
    const w = window.innerWidth;
    const h = Math.min(window.innerHeight, document.documentElement.getBoundingClientRect().height);
    return [0.12, 0.88].every(rx => [0.1, 0.3, 0.5, 0.7, 0.9].every(ry => blankAt(w * rx, h * ry)));
  };

  const markDotted = () => {
    if (document.body) document.body.classList.toggle('viz-dotted', isNarrow());
  };

  // 裁掉四周全透明的像素：窄组件样机截出来只有中间一块内容，四周留白在导出图里没有意义
  const cropTransparent = async (blob: Blob) => {
    const bmp = await createImageBitmap(blob);
    const full = document.createElement('canvas');
    full.width = bmp.width;
    full.height = bmp.height;
    const ctx = full.getContext('2d', { willReadFrequently: true });
    if (!ctx) return blob;
    ctx.drawImage(bmp, 0, 0);
    bmp.close?.();
    const { data } = ctx.getImageData(0, 0, full.width, full.height);
    let x0 = full.width, y0 = full.height, x1 = -1, y1 = -1;
    for (let y = 0; y < full.height; y++) {
      for (let x = 0; x < full.width; x++) {
        if (data[(y * full.width + x) * 4 + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0 || (x0 === 0 && y0 === 0 && x1 === full.width - 1 && y1 === full.height - 1)) return blob;
    const out = document.createElement('canvas');
    out.width = x1 - x0 + 1;
    out.height = y1 - y0 + 1;
    const octx = out.getContext('2d');
    if (!octx) return blob;
    octx.drawImage(full, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return (await new Promise<Blob | null>(res => out.toBlob(b => res(b), 'image/png'))) || blob;
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
    // 点阵衬底只用于内嵌展示，导出的图像不要它：截图期间用内联样式压掉背景图（压过 .viz-dotted 的类规则），
    // 结束后还原内联原值；不走摘 class，避免截图过程中尺寸观察回调又把类加回来。
    // 窄组件样机连 html / body 自身的底色也去掉，组件四周导出为透明，再按内容裁掉留白
    const roots = [document.documentElement, document.body];
    const saved = roots.map(el => el.style.cssText);
    const narrow = isNarrow();
    document.body.style.backgroundImage = 'none';
    if (narrow) roots.forEach(el => {
      el.style.backgroundColor = 'transparent';
      el.style.backgroundImage = 'none';
    });
    try {
      let blob = await toBlob(document.body, { pixelRatio: 2, cacheBust: false });
      if (!blob) throw new Error('empty');
      if (narrow) blob = await cropTransparent(blob);
      post({ type: VIZ_MSG_TYPE, kind: 'snapshot', id: m.id, blob });
    } catch (err) {
      post({ type: VIZ_MSG_TYPE, kind: 'snapshot', id: m.id, error: err instanceof Error ? err.message : String(err) });
    } finally {
      roots.forEach((el, i) => { el.style.cssText = saved[i]; });
    }
  });
}

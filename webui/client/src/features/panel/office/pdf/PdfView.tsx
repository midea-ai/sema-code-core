import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import { Spinner } from '../../../../common/ui';
import { t } from '../../../../i18n';
import { loadPdf } from '../loaders';
import { viewState } from '../bytes';
import type { Zoom } from '../ZoomDropdown';

const CSS_UNITS = 96 / 72; // PDF 的单位是 pt（1/72 英寸），100% 缩放对应 96dpi 的 CSS 像素
const PAD = 16, GAP = 12;
const NEAR = 1000; // 可视区上下各这么多像素内的页才持有 canvas / 文本层，其余释放
const MAX_PIXELS = 16 * 1024 * 1024; // 单页 canvas 像素上限：高分屏 + 大缩放时降采样，避免吃光显存
const RENDER_DELAY = 150; // 缩放连续变化（拖分隔条）时先靠 CSS 拉伸旧画面，停下来再按新比例重画

export interface PdfPageInfo { cur: number; total: number }

interface Slot {
  near: boolean;
  /** 已画好 / 正在画的缩放比例 */
  scale?: number;
  pending?: number;
  task?: RenderTask;
  canvas?: HTMLCanvasElement;
  text?: TextLayer;
  textEl?: HTMLDivElement;
}

function freeCanvas(c?: HTMLCanvasElement) {
  if (!c) return;
  c.width = 0; c.height = 0; // 立即归还位图内存，不等 GC
  c.remove();
}

/**
 * pdf 预览：全部页面纵向连续排布，只有可视区附近的页才真正渲染（canvas + 透明文本层供选中复制），滚远了就释放。
 * 页框由 React 按页面尺寸与缩放排版；canvas 和文本层由命令式代码挂进页框，React 不管其子节点。
 */
export function PdfView({ buf, zoom, tabId, onFitPct, onError, onPage, pagerRef }: {
  buf: ArrayBuffer; zoom: Zoom; tabId: string; onFitPct: (pct: number | null) => void; onError: (msg: string) => void;
  onPage?: (info: PdfPageInfo | null) => void;
  /** 头部翻页按钮用：注册「跳到第 n 页（从 0 起）」 */
  pagerRef?: React.MutableRefObject<((page: number) => void) | null>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef<Array<HTMLDivElement | null>>([]);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  /** 每页 100% 缩放下的 CSS 像素尺寸 */
  const [sizes, setSizes] = useState<Array<{ w: number; h: number }>>([]);
  const [stageW, setStageW] = useState(0);
  const [cur, setCur] = useState(0);
  // 阅读位置锚点：视口顶端落在哪一页的什么比例处。缩放 / 重排后按它还原；首次打开用它还原上次的页码
  const anchor = useRef({ page: 0, frac: 0 });
  const muteUntil = useRef(0); // 翻页按钮触发的滚动不反过来改当前页

  // ---------- 打开文档 ----------
  useEffect(() => {
    let alive = true;
    let task: { destroy(): Promise<void> } | null = null;
    setDoc(null); setSizes([]);
    loadPdf().then(lib => {
      if (!alive) return null;
      // data 会被转移给 worker（原缓冲区随之失效），而 buf 还留在字节缓存里供切回标签复用，所以传副本
      const lt = lib.getDocument({
        data: new Uint8Array(buf.slice(0)),
        cMapUrl: `${__PDFJS_ASSETS__}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${__PDFJS_ASSETS__}standard_fonts/`,
        wasmUrl: `${__PDFJS_ASSETS__}wasm/`,
      });
      task = lt;
      return lt.promise;
    }).then(async pdf => {
      if (!pdf || !alive) return;
      const dim = (p: PDFPageProxy) => { const v = p.getViewport({ scale: CSS_UNITS }); return { w: v.width, h: v.height }; };
      const first = dim(await pdf.getPage(1));
      if (!alive) return;
      anchor.current = { page: Math.min(viewState.get(tabId)?.page || 0, pdf.numPages - 1), frac: 0 };
      setSizes(Array.from({ length: pdf.numPages }, () => first));
      setDoc(pdf);
      // 其余页的尺寸后台补齐：绝大多数文档各页等大，只有确实不同时才重排
      const all = [first];
      for (let i = 2; i <= pdf.numPages; i++) {
        all.push(dim(await pdf.getPage(i)));
        if (!alive) return;
      }
      if (all.some(s => s.w !== first.w || s.h !== first.h)) setSizes(all);
    }).catch(e => { if (alive) onError(e?.message || String(e)); });
    return () => { alive = false; task?.destroy().catch(() => {}); };
  }, [buf]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 缩放与排版 ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setStageW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxW = useMemo(() => sizes.reduce((m, s) => Math.max(m, s.w), 0), [sizes]);
  const fit = maxW && stageW ? Math.min(3, Math.max(0.1, (stageW - PAD * 2) / maxW)) : 1;
  const z = zoom === 'fit' ? fit : Number(zoom) / 100;
  const ready = !!doc && stageW > 0;
  useEffect(() => { if (ready) onFitPct(zoom === 'fit' ? Math.round(z * 100) : null); }, [ready, zoom, z, onFitPct]);

  const boxes = useMemo(() => {
    let top = PAD;
    return sizes.map(s => { const b = { top, w: Math.floor(s.w * z), h: Math.floor(s.h * z) }; top += b.h + GAP; return b; });
  }, [sizes, z]);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  // 排版变了按锚点还原滚动位置；随之而来的 scroll 事件会把当前页算出来
  useLayoutEffect(() => {
    const el = scrollRef.current, b = boxes[anchor.current.page];
    if (!el || !b || !ready) return;
    const { page, frac } = anchor.current;
    // 页顶留半个内边距；停在文档开头时滚到 0，把顶部内边距完整露出来
    el.scrollTop = page === 0 && frac === 0 ? 0 : b.top - PAD / 2 + frac * b.h;
  }, [boxes, ready]);

  // ---------- 当前页：可见面积最大的那一页 ----------
  const onScroll = () => {
    const el = scrollRef.current, bs = boxesRef.current;
    if (!el || !bs.length || performance.now() < muteUntil.current) return;
    const top = el.scrollTop, bottom = top + el.clientHeight;
    let best = 0, bestArea = -1, first = -1;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (b.top + b.h <= top) continue;
      if (b.top >= bottom) break;
      if (first < 0) first = i;
      const area = Math.min(bottom, b.top + b.h) - Math.max(top, b.top);
      if (area > bestArea) { bestArea = area; best = i; }
    }
    if (first >= 0) anchor.current = { page: first, frac: Math.max(0, (top + PAD / 2 - bs[first].top) / bs[first].h) };
    setCur(best);
  };

  const go = (page: number) => {
    const el = scrollRef.current, bs = boxesRef.current;
    if (!el || !bs.length) return;
    const p = Math.min(bs.length - 1, Math.max(0, page));
    anchor.current = { page: p, frac: 0 };
    // 直接认定目标页为当前页：文档末尾滚不动时靠面积算出来的仍是前一页，翻页按钮会卡住
    muteUntil.current = performance.now() + 100;
    el.scrollTop = p === 0 ? 0 : bs[p].top - PAD / 2;
    setCur(p);
  };
  useEffect(() => {
    if (!pagerRef) return;
    pagerRef.current = go;
    return () => { pagerRef.current = null; };
  });
  useEffect(() => {
    if (!doc) return;
    viewState.set(tabId, { ...viewState.get(tabId), page: cur });
    onPage?.({ cur, total: doc.numPages });
  }, [doc, cur]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onPage?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 渲染：只画可视区附近的页 ----------
  const slots = useRef<Slot[]>([]);
  const zRef = useRef(z);
  zRef.current = z;
  const renderNear = useRef<() => void>(() => {});

  useEffect(() => {
    const root = scrollRef.current;
    if (!doc || !root) return;
    let alive = true;
    const list: Slot[] = Array.from({ length: doc.numPages }, () => ({ near: false }));
    slots.current = list;

    const release = (s: Slot) => {
      s.task?.cancel(); s.task = undefined;
      freeCanvas(s.canvas); s.canvas = undefined;
      s.text?.cancel(); s.text = undefined;
      s.textEl?.remove(); s.textEl = undefined;
      s.scale = s.pending = undefined;
    };

    const render = async (i: number) => {
      const s = list[i], host = pageEls.current[i];
      const scale = zRef.current * CSS_UNITS;
      if (!s.near || !host || s.scale === scale || s.pending === scale) return;
      s.pending = scale;
      s.task?.cancel();
      try {
        const lib = await loadPdf();
        const page = await doc.getPage(i + 1);
        if (!alive || !s.near || s.pending !== scale) return;
        const viewport = page.getViewport({ scale });
        let out = window.devicePixelRatio || 1;
        if (viewport.width * viewport.height * out * out > MAX_PIXELS) out = Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * out);
        canvas.height = Math.floor(viewport.height * out);
        // 尺寸跟页框走：缩放变化到重画完成之间由 CSS 拉伸顶着
        canvas.style.cssText = 'display:block;width:100%;height:100%';
        const task = page.render({ canvas, viewport, transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined });
        s.task = task;
        await task.promise;
        if (!alive || !s.near || s.pending !== scale) { freeCanvas(canvas); return; }
        // 画完再替换，旧画面一直留到新画面就绪，不闪白
        freeCanvas(s.canvas);
        host.prepend(canvas);
        s.canvas = canvas; s.scale = scale; s.task = undefined;

        if (s.text) { s.text.update({ viewport }); return; }
        const textEl = document.createElement('div');
        textEl.className = 'textLayer';
        const text = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: textEl, viewport });
        s.text = text; s.textEl = textEl;
        await text.render();
        if (!alive || s.text !== text) return;
        // 垫在文字之下的整页占位块：按住拖选时铺满整页，鼠标划过文字间的空白处选区不会乱跳
        const end = document.createElement('div');
        end.className = 'endOfContent';
        textEl.append(end);
        host.append(textEl);
      } catch (e: any) {
        if (e?.name !== 'RenderingCancelledException' && e?.name !== 'AbortException') console.warn('[pdf] render page', i + 1, e);
      } finally {
        if (s.pending === scale) s.pending = undefined;
      }
    };

    renderNear.current = () => { list.forEach((s, i) => { if (s.near) render(i); }); };

    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const i = Number((e.target as HTMLElement).dataset.page), s = list[i];
        if (!s) continue;
        s.near = e.isIntersecting;
        if (s.near) render(i); else release(s);
      }
    }, { root, rootMargin: `${NEAR}px 0px` });
    pageEls.current.slice(0, doc.numPages).forEach(el => el && io.observe(el));
    return () => { alive = false; io.disconnect(); list.forEach(release); renderNear.current = () => {}; };
  }, [doc, ready]);

  useEffect(() => {
    const timer = window.setTimeout(() => renderNear.current(), RENDER_DELAY);
    return () => clearTimeout(timer);
  }, [z]);

  // ---------- 交互 ----------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 上下方向键 / PageUp / PageDown / 空格交给原生滚动，这里只补「整页跳转」
    switch (e.key) {
      case 'ArrowLeft': go(cur - 1); break;
      case 'ArrowRight': go(cur + 1); break;
      case 'Home': go(0); break;
      case 'End': go(boxes.length - 1); break;
      default: return;
    }
    e.preventDefault();
  };
  // 拖选期间给文本层加 selecting：占位块铺满整页（见 index.css）
  const onMouseDown = (e: React.MouseEvent) => {
    const layer = (e.target as HTMLElement).closest?.('.textLayer');
    if (!layer) return;
    layer.classList.add('selecting');
    window.addEventListener('mouseup', () => layer.classList.remove('selecting'), { once: true });
  };

  return (
    <div ref={scrollRef} tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown} onMouseDown={onMouseDown}
      className="pdf-view relative h-full overflow-auto bg-panel outline-none font-sans">
      {!doc && <div className="p-4 text-sm text-muted flex items-center gap-2"><Spinner />{t('office.loading')}</div>}
      {ready && (
        <div className="flex flex-col items-center min-w-fit" style={{ padding: PAD, gap: GAP }}>
          {boxes.map((b, i) => (
            <div key={i} ref={el => { pageEls.current[i] = el; }} data-page={i} className="pdf-page relative shrink-0 bg-white shadow-md overflow-hidden"
              style={{ width: b.w, height: b.h, '--total-scale-factor': z * CSS_UNITS } as React.CSSProperties} />
          ))}
        </div>
      )}
    </div>
  );
}

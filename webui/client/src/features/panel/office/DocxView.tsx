import { useEffect, useRef, useState } from 'react';
import { Spinner } from '../../../common/ui';
import { t } from '../../../i18n';
import { loadDocx } from './loaders';
import type { Zoom } from './ZoomDropdown';

// shadow 内的自有样式：排在库注入的样式之后，同选择器后者生效。
// 灰底交给外层 bg-panel；.wrap 随页宽撑开（放大后左侧不被居中布局裁掉），不足容器宽时撑满以保持居中
const OWN_CSS = `
:host{all:initial;display:block}
.wrap{min-width:100%;width:max-content;box-sizing:border-box}
.docx-wrapper{background:transparent;padding:16px 16px 0}
.docx-wrapper>section.docx{box-shadow:0 1px 4px rgb(0 0 0/.15);margin-bottom:16px}
`;
const PAD = 32; // .docx-wrapper 左右内边距合计

/**
 * docx 预览：docx-preview 渲染进 Shadow DOM——库注入的样式不外泄，全局 preflight（img 块级、标题重置等）也进不来。
 * 缩放用 CSS zoom（布局尺寸随之变化，滚动区域天然正确）；「适应宽度」按 100% 时量到的页宽换算。
 */
export function DocxView({ buf, zoom, onFitPct, onError }: {
  buf: ArrayBuffer; zoom: Zoom; onFitPct: (pct: number | null) => void; onError: (msg: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const pageW = useRef(0);
  const [ready, setReady] = useState(false);
  const [boxW, setBoxW] = useState(0);

  useEffect(() => {
    const host = hostRef.current!;
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('div');
    const own = document.createElement('style');
    own.textContent = OWN_CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    root.replaceChildren(styleEl, own, wrap);
    wrapRef.current = wrap;
    let alive = true;
    setReady(false);
    loadDocx()
      // useBase64URL：库不回收 blob URL，反复开关标签会泄漏；base64 随 DOM 一起释放
      .then(lib => lib.renderAsync(buf, wrap, styleEl, { inWrapper: true, breakPages: true, experimental: true, useBase64URL: true, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true }))
      .then(() => {
        if (!alive) return;
        // 先在 100% 下量页宽再交给缩放 effect（zoom 下 offsetWidth 的语义随 Chromium 版本有差异）
        wrap.style.zoom = '1';
        let w = 0;
        wrap.querySelectorAll<HTMLElement>('section.docx').forEach(s => { w = Math.max(w, s.offsetWidth); });
        pageW.current = w;
        setReady(true);
      })
      .catch(e => { if (alive) onError(e?.message || String(e)); });
    return () => { alive = false; };
  }, [buf]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const update = () => setBoxW(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !ready) return;
    const fit = pageW.current && boxW ? Math.min(2, Math.max(0.25, boxW / (pageW.current + PAD))) : 1;
    const z = zoom === 'fit' ? fit : Number(zoom) / 100;
    wrap.style.zoom = String(z);
    onFitPct(zoom === 'fit' ? Math.round(z * 100) : null);
  }, [zoom, ready, boxW, onFitPct]);

  return (
    // scrollbarGutter：适应宽度时滚动条出现/消失会改变可用宽度，预留槽位避免来回抖动
    <div ref={boxRef} className="h-full overflow-auto bg-panel font-sans" style={{ scrollbarGutter: 'stable' }}>
      {!ready && <div className="p-4 text-sm text-muted flex items-center gap-2"><Spinner />{t('office.loading')}</div>}
      <div ref={hostRef} className={ready ? undefined : 'invisible h-0 overflow-hidden'} />
    </div>
  );
}

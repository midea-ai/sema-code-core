import { useEffect, useRef, useState } from 'react';
import { cn, Spinner } from '../../../../common/ui';
import { t } from '../../../../i18n';
import { loadPptx } from '../loaders';
import { viewState } from '../bytes';
import type { Zoom } from '../ZoomDropdown';
import { readDeckMeta } from './notes';
import { dropDanglingParts } from './sanitize';

const BASE_W = 960; // 幻灯片统一按这个宽度渲染一次，之后的缩放全靠 CSS
const THUMB_W = 120;
const NARROW_IN = 560, NARROW_OUT = 600; // 窄模式阈值带滞回，拖分隔条经过临界宽度时不来回闪
const OPEN_DELAY = 80, CLOSE_DELAY = 250;
const CHART_SETTLE = 1500; // 图表入场动画时长：动画期间克隆的缩略图是半截的，到点重新克隆
const MAX_TICKS = 40;

interface Deck {
  /** 演示顺序位置 → 库内幻灯片下标（库按文件名数字排序，与演示顺序可能不一致） */
  order: number[];
  /** 按演示顺序的备注 */
  notes: string[];
  slideH: number;
  els: HTMLElement[];
  readyAt: number;
}

/**
 * pptx 预览：左侧缩略图栏 + 主幻灯片 + 下方备注卡片；面板窄时缩略图栏收成左缘的短横线指示条，悬停滑出浮层。
 * pptx-preview 的图表销毁走模块级全局事件（任一实例切页 / 销毁都会清掉所有实例的图表），所以不开多实例也不用它的切页：
 * 单实例 list 模式把全部幻灯片渲染一次，主视图把它们叠放后只切可见性；缩略图是克隆出来的静态副本（图表是 SVG，可克隆）。
 */
export function PptxView({ buf, zoom, tabId, onFitPct, onError }: {
  buf: ArrayBuffer; zoom: Zoom; tabId: string; onFitPct: (pct: number | null) => void; onError: (msg: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const thumbRefs = useRef<Array<HTMLElement | null>>([]);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cur, setCur] = useState(0);
  const [narrow, setNarrow] = useState(true);
  const [railOpen, setRailOpen] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });

  // ---------- 渲染 ----------
  useEffect(() => {
    const host = hostRef.current!;
    // 每次渲染用独立的容器：上一次尚未结束的异步渲染只会写进已被摘掉的旧容器
    const box = document.createElement('div');
    host.replaceChildren(box);
    let alive = true;
    let previewer: { destroy(): void } | null = null;
    setDeck(null);
    // 容错处理自身失败就退回原始字节，交给库照常解析
    Promise.all([loadPptx(), dropDanglingParts(buf).catch(() => buf)]).then(([lib, data]) => {
      const pv = lib.init(box, { width: BASE_W, mode: 'list' });
      previewer = pv;
      return pv.preview(data).then(() => pv.pptx);
    }).then(async pptx => {
      if (!alive) return;
      // 库把部件加载异常吞掉了，表现为 0 张幻灯片；当失败处理，留「用默认程序打开」兜底，不给一片空白
      if (!pptx.slides.length) throw new Error(t('office.noSlides'));
      const slideH = BASE_W * pptx.height / pptx.width;
      const wrapper = box.querySelector<HTMLElement>('.pptx-preview-wrapper');
      if (wrapper) Object.assign(wrapper.style, { background: 'transparent', width: `${BASE_W}px`, height: `${slideH}px`, margin: '0', overflow: 'hidden' });
      // 叠放：全部保持在布局里（图表要在有尺寸的容器里初始化，不能 display:none），只切 visibility
      const els = pptx.slides.map((_, i) => box.querySelector<HTMLElement>(`.pptx-preview-slide-wrapper-${i}`)!).filter(Boolean);
      for (const el of els) Object.assign(el.style, { position: 'absolute', left: '0', top: '0', margin: '0', visibility: 'hidden' });
      const meta = await readDeckMeta(p => pptx.getXmlByPath(p).catch(() => null)).catch(() => ({ order: [], notes: {} as Record<string, string> }));
      if (!alive) return;
      const byName = meta.order.map(path => ({ path, idx: pptx.slides.findIndex(s => s.name === path) })).filter(x => x.idx >= 0 && els[x.idx]);
      // 演示顺序读不出来时退回库的顺序
      const ordered = byName.length ? byName : els.map((_, idx) => ({ path: pptx.slides[idx].name, idx }));
      setDeck({ order: ordered.map(x => x.idx), notes: ordered.map(x => meta.notes[x.path] || ''), slideH, els, readyAt: Date.now() });
      setCur(Math.min(viewState.get(tabId)?.slide || 0, Math.max(0, ordered.length - 1)));
    }).catch(e => { if (alive) onError(e?.message || String(e)); });
    return () => { alive = false; previewer?.destroy(); box.remove(); };
  }, [buf]); // eslint-disable-line react-hooks/exhaustive-deps

  // 当前页可见
  useEffect(() => {
    if (!deck) return;
    deck.els.forEach((el, i) => { el.style.visibility = i === deck.order[cur] ? 'visible' : 'hidden'; });
  }, [deck, cur]);

  // ---------- 尺寸：窄模式判定量根节点（文件树抽屉会挤占宽度，不能用右栏宽度），适应缩放量舞台 ----------
  useEffect(() => {
    const root = rootRef.current, st = stageRef.current;
    if (!root || !st) return;
    const update = () => {
      const w = root.clientWidth;
      setNarrow(n => (n ? w < NARROW_OUT : w < NARROW_IN));
      setStage(s => (s.w === st.clientWidth && s.h === st.clientHeight ? s : { w: st.clientWidth, h: st.clientHeight }));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(root); ro.observe(st);
    return () => ro.disconnect();
  }, [deck]);

  const fit = deck && stage.w && stage.h ? Math.min(3, Math.max(0.1, Math.min((stage.w - 32) / BASE_W, (stage.h - 32) / deck.slideH))) : 1;
  const z = zoom === 'fit' ? fit : Number(zoom) / 100;
  useEffect(() => { if (deck) onFitPct(zoom === 'fit' ? Math.round(z * 100) : null); }, [deck, zoom, z, onFitPct]);

  // ---------- 缩略图：进入缩略图栏可视区才克隆 ----------
  useEffect(() => {
    const rail = railRef.current;
    if (!deck || !rail) return;
    const timers: number[] = [];
    const filled = new Set<number>();
    const fill = (pos: number) => {
      const slot = thumbRefs.current[pos], src = deck.els[deck.order[pos]];
      if (!slot || !src) return;
      const clone = src.cloneNode(true) as HTMLElement;
      Object.assign(clone.style, { visibility: 'visible', transform: `scale(${THUMB_W / BASE_W})`, transformOrigin: '0 0', pointerEvents: 'none' });
      slot.replaceChildren(clone);
      const wait = deck.readyAt + CHART_SETTLE - Date.now();
      if (wait > 0 && src.querySelector('.chart-node')) timers.push(window.setTimeout(() => fill(pos), wait));
    };
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const pos = Number((e.target as HTMLElement).dataset.pos);
        if (e.isIntersecting && !filled.has(pos)) { filled.add(pos); fill(pos); }
      }
    }, { root: rail, rootMargin: '200px 0px' });
    thumbRefs.current.slice(0, deck.order.length).forEach(el => el && io.observe(el));
    return () => { io.disconnect(); timers.forEach(clearTimeout); };
  }, [deck]);

  // ---------- 切页 ----------
  const count = deck?.order.length || 0;
  const go = (pos: number) => {
    const p = Math.min(count - 1, Math.max(0, pos));
    viewState.set(tabId, { ...viewState.get(tabId), slide: p });
    setCur(p);
    // 缩略图滚进可视区：手动改 scrollTop（scrollIntoView 会连带滚动祖先容器，浮层收在屏外时会把整个面板带偏）
    const rail = railRef.current, btn = thumbRefs.current[p]?.parentElement;
    if (rail && btn) {
      if (btn.offsetTop < rail.scrollTop) rail.scrollTop = btn.offsetTop - 8;
      else if (btn.offsetTop + btn.offsetHeight > rail.scrollTop + rail.clientHeight) rail.scrollTop = btn.offsetTop + btn.offsetHeight - rail.clientHeight + 8;
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowLeft': case 'PageUp': go(cur - 1); break;
      case 'ArrowDown': case 'ArrowRight': case 'PageDown': case ' ': go(cur + 1); break;
      case 'Home': go(0); break;
      case 'End': go(count - 1); break;
      case 'Escape': setRailOpen(false); break;
      default: return;
    }
    e.preventDefault();
  };

  // ---------- 窄模式：悬停指示条滑出缩略图浮层（进入稍作延迟防路过误触；离开「指示条 ∪ 浮层」后延迟收起） ----------
  const hoverTimer = useRef(0);
  const hover = (inside: boolean) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setRailOpen(inside), inside ? OPEN_DELAY : CLOSE_DELAY);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  useEffect(() => { if (!narrow) setRailOpen(false); }, [narrow]);
  // 浮层展开时把当前页缩略图带进可视区
  useEffect(() => { if (railOpen) go(cur); }, [railOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // 页数多时指示条只画当前页附近的一段
  const tickFrom = count > MAX_TICKS ? Math.min(count - MAX_TICKS, Math.max(0, cur - MAX_TICKS / 2)) : 0;
  const ticks = Array.from({ length: Math.min(count, MAX_TICKS) }, (_, i) => tickFrom + i);
  const note = deck?.notes[cur];

  return (
    <div ref={rootRef} tabIndex={0} onKeyDown={onKeyDown} className="relative h-full flex font-sans bg-white outline-none overflow-hidden">
      {deck && (
        <div ref={railRef} onMouseEnter={narrow ? () => hover(true) : undefined} onMouseLeave={narrow ? () => hover(false) : undefined}
          className={cn('w-[168px] shrink-0 overflow-y-auto bg-white p-1.5',
            narrow ? cn('absolute z-20 left-2 top-2 bottom-2 rounded-xl border border-border shadow-lg transition-transform duration-150', railOpen ? 'translate-x-0' : '-translate-x-[calc(100%+8px)]') : 'border-r border-border')}>
          {deck.order.map((_, pos) => (
            <button key={pos} onClick={() => go(pos)} className={cn('w-full flex items-start gap-2 p-1.5 rounded-lg', pos === cur ? 'bg-accent/10' : 'hover:bg-black/[0.05]')}>
              <span className={cn('w-5 shrink-0 pt-0.5 text-right text-xs', pos === cur ? 'text-accent' : 'text-muted')}>{pos + 1}</span>
              <span ref={el => { thumbRefs.current[pos] = el; }} data-pos={pos}
                className={cn('relative block shrink-0 overflow-hidden rounded-md bg-white border', pos === cur ? 'border-accent outline-2 outline-accent' : 'border-border')}
                style={{ width: THUMB_W, height: THUMB_W * deck.slideH / BASE_W }} />
            </button>
          ))}
        </div>
      )}
      {deck && narrow && (
        <div onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)} className="absolute z-10 left-0 inset-y-0 w-7 flex flex-col items-start justify-center gap-[5px] pl-2.5">
          {ticks.map(pos => (
            <button key={pos} onClick={() => go(pos)} className="py-px -my-px block" tabIndex={-1}>
              <span className={cn('block h-0.5 rounded', pos === cur ? 'w-5 bg-fg' : 'w-3 bg-black/20')} />
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        <div ref={stageRef} className="flex-1 min-h-0 overflow-auto flex p-4">
          {!deck && <div className="text-sm text-muted flex items-center gap-2 self-start"><Spinner />{t('office.loading')}</div>}
          {/* 库的样式假定宿主没有改过行高 / 对齐，这里把继承来的全局排版属性还原 */}
          <div ref={hostRef} className={cn('relative m-auto shrink-0 overflow-hidden rounded-lg bg-white shadow-md', !deck && 'invisible absolute')}
            style={{ width: BASE_W, height: deck?.slideH, zoom: z, lineHeight: 'normal', textAlign: 'left', color: 'black' }} />
        </div>
        {note && <div className="mx-4 mb-4 shrink-0 max-h-40 overflow-auto rounded-xl border border-border bg-white px-4 py-3 text-sm text-fg whitespace-pre-wrap">{note}</div>}
      </div>
    </div>
  );
}

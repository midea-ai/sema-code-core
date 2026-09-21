import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../../../../common/ui';
import { ChartBox } from './ChartBox';
import { Borders, CellModel, CellStyle, SheetModel, cellKey, colName } from './model';

export interface Sel { r: number; c: number }

const HEAD_H = 20;
const OVER_R = 8, OVER_C = 5; // 可视区外多渲染的行 / 列，滚动时不露白
const SPILL_COLS = 20; // 文本向右侧空格溢出最多跨的列数
const FONT = "Calibri, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif";

/** 在前缀和里二分：返回 xs[i] <= v 的最大 i（夹在有效行 / 列范围内） */
function locate(xs: number[], v: number): number {
  let lo = 0, hi = xs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= v) lo = mid; else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function borderCss(b: Borders): React.CSSProperties {
  const side = (x?: Borders['t']) => (x ? `${x.w}px ${x.style} ${x.color}` : undefined);
  return { borderTop: side(b.t), borderRight: side(b.r), borderBottom: side(b.b), borderLeft: side(b.l) };
}

/**
 * 只读虚拟滚动网格：单一滚动容器 + 撑开总尺寸的占位层，行列头用 sticky（不靠 JS 同步，滚动无滞后）。
 * 只渲染可视窗口内的格子；合并单元格单独收集后整块绘制，主格滚出视口时合并区仍然正确。
 * 缩放不用 CSS zoom（会让 scrollTop 的换算混乱），scale 直接乘到所有度量和字号上。
 */
export function Grid({ sheet, scale, sel, onSelect }: { sheet: SheetModel; scale: number; sel: Sel; onSelect: (s: Sel) => void }) {
  const { colX, rowY, rowCount, colCount, cells, styles, merges, mergeAt } = sheet;
  const boxRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ r0: 0, r1: 0, c0: 0, c1: 0 });
  const headH = HEAD_H * scale;
  const headW = Math.max(36, String(rowCount).length * 8 + 14) * scale;

  const measure = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r0 = Math.max(0, locate(rowY, el.scrollTop / scale) - OVER_R);
    const r1 = Math.min(rowCount - 1, locate(rowY, (el.scrollTop + el.clientHeight - headH) / scale) + OVER_R);
    const c0 = Math.max(0, locate(colX, el.scrollLeft / scale) - OVER_C);
    const c1 = Math.min(colCount - 1, locate(colX, (el.scrollLeft + el.clientWidth - headW) / scale) + OVER_C);
    setView(v => (v.r0 === r0 && v.r1 === r1 && v.c0 === c0 && v.c1 === c1 ? v : { r0, r1, c0, c1 }));
  }, [rowY, colX, rowCount, colCount, scale, headH, headW]);

  useEffect(() => {
    measure();
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const raf = useRef(0);
  const onScroll = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; measure(); });
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  /** 选区对应的行列范围：落在合并区里就是整个合并区 */
  const rangeOf = (s: Sel) => {
    const mi = mergeAt.get(cellKey(s.r, s.c));
    return mi === undefined ? { r1: s.r, c1: s.c, r2: s.r, c2: s.c } : merges[mi];
  };
  const selRange = rangeOf(sel);

  const pick = (e: React.MouseEvent) => {
    const rect = layerRef.current!.getBoundingClientRect();
    const r = locate(rowY, (e.clientY - rect.top) / scale), c = locate(colX, (e.clientX - rect.left) / scale);
    const mi = mergeAt.get(cellKey(r, c));
    onSelect(mi === undefined ? { r, c } : { r: merges[mi].r1, c: merges[mi].c1 });
  };

  /** 键盘移动后把目标格滚进可视区（表头占掉的那部分要让出来） */
  const reveal = (s: Sel) => {
    const el = boxRef.current;
    if (!el) return;
    const g = rangeOf(s);
    const x0 = colX[g.c1] * scale, x1 = colX[g.c2 + 1] * scale, y0 = rowY[g.r1] * scale, y1 = rowY[g.r2 + 1] * scale;
    if (x0 < el.scrollLeft) el.scrollLeft = x0; else if (x1 > el.scrollLeft + el.clientWidth - headW) el.scrollLeft = x1 - el.clientWidth + headW;
    if (y0 < el.scrollTop) el.scrollTop = y0; else if (y1 > el.scrollTop + el.clientHeight - headH) el.scrollTop = y1 - el.clientHeight + headH;
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const g = selRange;
    let r = sel.r, c = sel.c;
    switch (e.key) {
      case 'ArrowUp': r = g.r1 - 1; break;
      case 'ArrowDown': case 'Enter': r = g.r2 + 1; break;
      case 'ArrowLeft': c = g.c1 - 1; break;
      case 'ArrowRight': case 'Tab': c = g.c2 + 1; break;
      case 'Home': c = 0; break;
      case 'End': c = Math.max(0, (cells[sel.r]?.length || 1) - 1); break;
      default: return;
    }
    e.preventDefault();
    r = Math.min(rowCount - 1, Math.max(0, r)); c = Math.min(colCount - 1, Math.max(0, c));
    const mi = mergeAt.get(cellKey(r, c));
    const next = mi === undefined ? { r, c } : { r: merges[mi].r1, c: merges[mi].c1 };
    onSelect(next);
    reveal(next);
  };

  // ---------- 可视窗口内的格子 ----------
  const { r0, r1, c0, c1 } = view;
  const boxes: React.ReactNode[] = [];
  const pad = 3 * scale;
  const drawCell = (key: string, cell: CellModel | undefined, st: CellStyle, border: Borders | undefined, x: number, y: number, w: number, h: number, spillW: number, solid: boolean) => {
    if (cell?.text || st.fill || solid) {
      const hAlign = st.hAlign || (cell?.num ? 'right' : cell?.center ? 'center' : 'left');
      boxes.push(
        <div key={key} className={cn('absolute', solid && !st.fill && 'bg-white')} style={{ left: x, top: y, width: w, height: h, background: st.fill }}>
          {cell?.text && (
            <div className="relative flex overflow-hidden" style={{
              width: spillW, height: h, zIndex: spillW > w ? 1 : undefined,
              padding: `0 ${pad}px`, paddingLeft: st.indent ? pad + st.indent * 9 * scale : undefined,
              alignItems: st.vAlign === 'top' ? 'flex-start' : st.vAlign === 'middle' ? 'center' : 'flex-end',
              justifyContent: hAlign === 'right' ? 'flex-end' : hAlign === 'center' ? 'center' : 'flex-start',
              fontSize: (st.size || 11) * 4 / 3 * scale, lineHeight: 1.25, fontFamily: st.font ? `'${st.font}', ${FONT}` : undefined,
              fontWeight: st.bold ? 700 : undefined, fontStyle: st.italic ? 'italic' : undefined,
              textDecoration: cn(st.underline && 'underline', st.strike && 'line-through') || undefined,
              color: cell.color || st.color,
            }}>
              <span style={st.wrap ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word', textAlign: hAlign, minWidth: 0 } : { whiteSpace: 'nowrap' }}>{cell.text}</span>
            </div>
          )}
        </div>,
      );
    }
    // 边框单独一层并向左上各外扩 1px：与相邻格子的边框 / 网格线落在同一像素上，且不会被后画的填充盖住
    if (border) boxes.push(<div key={`${key}b`} className="absolute pointer-events-none z-[2]" style={{ left: x - 1, top: y - 1, width: w + 1, height: h + 1, ...borderCss(border) }} />);
  };

  const seen = new Set<number>();
  for (let r = r0; r <= r1; r++) {
    const h = (rowY[r + 1] - rowY[r]) * scale;
    const row = cells[r];
    for (let c = c0; c <= c1; c++) {
      const mi = mergeAt.size ? mergeAt.get(cellKey(r, c)) : undefined;
      if (mi !== undefined) { seen.add(mi); continue; }
      const cell = row?.[c];
      if (!cell || !h) continue;
      const w = (colX[c + 1] - colX[c]) * scale;
      if (!w) continue;
      const st = styles[cell.s];
      // 左对齐、不换行的文本向右侧连续空格溢出（与 Excel 一致），遇到有内容的格子或合并区为止
      let spillW = w;
      if (cell.text && !st.wrap && !cell.num && !cell.center && (!st.hAlign || st.hAlign === 'left')) {
        for (let k = c + 1; k < colCount && k <= c + SPILL_COLS && !row![k]?.text && !mergeAt.has(cellKey(r, k)); k++) spillW += (colX[k + 1] - colX[k]) * scale;
      }
      drawCell(`${r}:${c}`, cell, st, st.border, colX[c] * scale, rowY[r] * scale, w, h, spillW, false);
    }
  }
  for (const mi of seen) {
    const m = merges[mi];
    const cell = cells[m.r1]?.[m.c1];
    const st = cell ? styles[cell.s] : styles[0];
    const x = colX[m.c1] * scale, y = rowY[m.r1] * scale, w = (colX[m.c2 + 1] - colX[m.c1]) * scale, h = (rowY[m.r2 + 1] - rowY[m.r1]) * scale;
    // 合并区不透明：盖住从中穿过的网格线
    drawCell(`m${mi}`, cell, st, m.border, x, y, w, h, w, true);
  }

  const lines: React.ReactNode[] = [];
  if (sheet.gridLines) {
    const top = rowY[r0] * scale, left = colX[c0] * scale;
    const height = (rowY[r1 + 1] - rowY[r0]) * scale, width = (colX[c1 + 1] - colX[c0]) * scale;
    for (let c = c0; c <= c1; c++) lines.push(<div key={`v${c}`} className="absolute bg-border" style={{ left: colX[c + 1] * scale - 1, top, width: 1, height }} />);
    for (let r = r0; r <= r1; r++) lines.push(<div key={`h${r}`} className="absolute bg-border" style={{ top: rowY[r + 1] * scale - 1, left, height: 1, width }} />);
  }

  const headCls = 'absolute flex items-center justify-center border-border text-muted select-none';
  const headFont = 11 * scale;
  const W = headW + colX[colCount] * scale, H = headH + rowY[rowCount] * scale;
  const sx = colX[selRange.c1] * scale, sy = rowY[selRange.r1] * scale;
  return (
    <div ref={boxRef} tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown} className="h-full overflow-auto outline-none bg-white text-fg" style={{ fontFamily: FONT }}>
      <div className="relative" style={{ width: W, height: H }}>
        {/* 列头：整条 sticky 在顶部，左上角块在条内再 sticky 到左侧 */}
        <div className="sticky top-0 z-20" style={{ width: W, height: headH }}>
          <div className="sticky left-0 z-10 bg-panel border-r border-b border-border" style={{ width: headW, height: headH }} />
          {Array.from({ length: Math.max(0, c1 - c0 + 1) }, (_, i) => c0 + i).map(c => (
            <div key={c} className={cn(headCls, 'top-0 border-r border-b', c >= selRange.c1 && c <= selRange.c2 ? 'bg-black/[0.1] text-fg' : 'bg-panel')}
              style={{ left: headW + colX[c] * scale, width: (colX[c + 1] - colX[c]) * scale, height: headH, fontSize: headFont }}>{colName(c)}</div>
          ))}
        </div>
        {/* 行头 */}
        <div className="sticky left-0 z-10" style={{ width: headW, height: H - headH }}>
          {Array.from({ length: Math.max(0, r1 - r0 + 1) }, (_, i) => r0 + i).map(r => (
            <div key={r} className={cn(headCls, 'left-0 border-r border-b', r >= selRange.r1 && r <= selRange.r2 ? 'bg-black/[0.1] text-fg' : 'bg-panel')}
              style={{ top: rowY[r] * scale, height: (rowY[r + 1] - rowY[r]) * scale, width: headW, fontSize: headFont }}>{r + 1}</div>
          ))}
        </div>
        {/* 单元格层：点击按坐标反算行列，不给每个格子绑事件 */}
        <div ref={layerRef} onMouseDown={pick} className="absolute cursor-cell" style={{ left: headW, top: headH, width: W - headW, height: H - headH }}>
          {lines}
          {boxes}
          {sheet.anchors.map((a, i) => a.kind === 'image' && a.src
            ? <img key={`a${i}`} src={a.src} alt="" draggable={false} className="absolute z-[2] max-w-none" style={{ left: a.x * scale, top: a.y * scale, width: a.w * scale, height: a.h * scale }} />
            : <ChartBox key={`a${i}`} anchor={a} scale={scale} />)}
          <div className="absolute pointer-events-none z-[3] border-2 border-accent" style={{ left: sx - 1, top: sy - 1, width: colX[selRange.c2 + 1] * scale - sx + 1, height: rowY[selRange.r2 + 1] * scale - sy + 1 }} />
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { cn } from './ui';

/** 持久化在 localStorage 的面板宽度 */
export function usePanelWidth(key: string, def: number, min: number, max: number): [number, (w: number) => void] {
  const [w, setW] = useState(() => {
    const v = Number(localStorage.getItem(`sema.width.${key}`));
    return v > 0 ? Math.min(max, Math.max(min, v)) : def;
  });
  const set = useCallback((n: number) => setW(Math.min(max, Math.max(min, Math.round(n)))), [min, max]);
  useEffect(() => { localStorage.setItem(`sema.width.${key}`, String(w)); }, [key, w]);
  return [w, set];
}

/** 拖到最小宽度后，再多拖这么多像素就收起 */
const COLLAPSE_OVERSHOOT = 60;

/**
 * 竖向拖拽手柄：放在两栏之间；side='left' 表示被调整的面板在手柄左侧（向右拖变宽），'right' 反之。
 * 用 pointer capture，拖动经过 iframe 也不会丢事件。
 * 传了 min + onCollapse 的面板可拖动收起：越过最小宽度再多拖 COLLAPSE_OVERSHOOT 就收起，不松手往回拖到最小宽度处重新展开。
 * 这类面板的手柄在收起态也要继续渲染（传 collapsed）：拖动中卸载手柄会丢 pointer capture，就拖不回来了。
 */
export function ResizeHandle({ side, width, onResize, min, collapsed, onCollapse, className }: {
  side: 'left' | 'right'; width: number; onResize: (w: number) => void;
  min?: number; collapsed?: boolean; onCollapse?: (v: boolean) => void; className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    let hidden = false;
    const move = (ev: PointerEvent) => {
      const w = side === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX);
      if (onCollapse && min !== undefined) {
        // 收起线与展开线错开，指针停在线上不会反复收展
        const hide = hidden ? w < min : w < min - COLLAPSE_OVERSHOOT;
        if (hide !== hidden) {
          hidden = hide;
          onCollapse(hide);
          // 收起时宽度还原为拖动前的值，之后点按钮展开不会停在最小宽度
          if (hide) onResize(startW);
        }
        if (hide) return;
      }
      onResize(w);
    };
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      setDragging(false);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  return (
    <div onPointerDown={onPointerDown}
      className={cn('relative shrink-0 w-0 z-10 cursor-col-resize group', collapsed && !dragging && 'pointer-events-none', className)}>
      <div className={cn('absolute inset-y-0 -left-[3px] w-[6px] transition-colors', dragging ? 'bg-accent/50' : 'group-hover:bg-accent/30')} />
    </div>
  );
}

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

/**
 * 竖向拖拽手柄：放在两栏之间；side='left' 表示被调整的面板在手柄左侧（向右拖变宽），'right' 反之。
 * 用 pointer capture，拖动经过 iframe 也不会丢事件。
 */
export function ResizeHandle({ side, width, onResize, className }: { side: 'left' | 'right'; width: number; onResize: (w: number) => void; className?: string }) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev: PointerEvent) => onResize(side === 'left' ? startW + (ev.clientX - startX) : startW - (ev.clientX - startX));
    const up = () => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      setDragging(false);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  return (
    <div onPointerDown={onPointerDown}
      className={cn('relative shrink-0 w-0 z-10 cursor-col-resize group', className)}>
      <div className={cn('absolute inset-y-0 -left-[3px] w-[6px] transition-colors', dragging ? 'bg-accent/50' : 'group-hover:bg-accent/30')} />
    </div>
  );
}

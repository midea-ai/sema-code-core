import React, { useRef, useState } from 'react';
import { Popover, cn } from './ui';

export interface IconSelectOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
  disabled?: boolean;
}

/** 选项数超过该值时，下拉面板顶部显示搜索框 */
const SEARCH_THRESHOLD = 10;

/**
 * 表单用下拉选择器（对齐参考实现 IconSelect）：选项支持图标 / 禁用态 / 搜索，弹层完全受控。
 */
export function IconSelect({ id, value, options, onChange, disabled, placeholder, className }: {
  id?: string; value: string; options: IconSelectOption[]; onChange: (v: string) => void; disabled?: boolean; placeholder?: string; className?: string;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [filter, setFilter] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const current = options.find(o => o.value === value);
  const searchable = options.length > SEARCH_THRESHOLD;
  const kw = filter.trim().toLowerCase();
  const visible = searchable && kw ? options.filter(o => o.label.toLowerCase().includes(kw) || o.value.toLowerCase().includes(kw)) : options;
  const close = () => setRect(null);
  const pick = (o: IconSelectOption) => { if (o.disabled) return; onChange(o.value); close(); };
  return (
    <>
      <button ref={btn} type="button" id={id} disabled={disabled}
        onClick={() => { setFilter(''); setRect(btn.current!.getBoundingClientRect()); }}
        className={cn('w-full h-9 px-3 rounded-md bg-white border border-border text-sm text-left inline-flex items-center gap-2 hover:border-black/20 focus:border-accent disabled:bg-panel', className)}>
        {current?.icon}
        <span className={cn('flex-1 truncate', !current && 'text-muted')}>{current?.label ?? (value || placeholder || '')}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted shrink-0"><path d="M2 3.5l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.5" /></svg>
      </button>
      <Popover anchor={rect} onClose={close} className="py-1">
        <div style={{ minWidth: rect?.width ?? 200 }}>
          {searchable && (
            <div className="px-2 pb-1">
              <input autoFocus value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜索..."
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const f = visible.find(o => !o.disabled); if (f) pick(f); } }}
                className="w-full h-8 px-2 rounded-md bg-panel border border-border text-sm" />
            </div>
          )}
          {visible.length === 0 && <div className="px-3 py-2 text-sm text-muted">无匹配选项</div>}
          <div className="max-h-72 overflow-auto">
            {visible.map(o => (
              <button key={o.value} type="button" onClick={() => pick(o)} disabled={o.disabled}
                className={cn('w-full flex items-center gap-2.5 text-left px-3 py-1.5 rounded text-sm', o.disabled ? 'text-muted/50 cursor-not-allowed' : 'hover:bg-black/[0.05]')}>
                {o.icon && <span className="shrink-0 w-4 h-4 flex items-center justify-center">{o.icon}</span>}
                <span className="flex-1 truncate">{o.label}</span>
                {o.value === value && <svg width="14" height="14" viewBox="0 0 24 24" className="text-ok shrink-0"><path d="M5 12l5 5L20 7" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
              </button>
            ))}
          </div>
        </div>
      </Popover>
    </>
  );
}

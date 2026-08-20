/** 轻量 UI 原语：按钮 / 弹层 / 右键菜单 / 下拉 / 开关 / 对话框（无第三方组件库） */
import React, { useEffect, useRef, useState, createContext, useContext, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';

export function cn(...xs: Array<string | false | null | undefined>) { return xs.filter(Boolean).join(' '); }

// ---------- Button ----------
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'outline'; size?: 'sm' | 'md' | 'icon' };
export function Button({ variant = 'outline', size = 'md', className, ...rest }: BtnProps) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors select-none whitespace-nowrap';
  const sizes = { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3 text-sm', icon: 'h-7 w-7 text-sm' }[size];
  const variants = {
    primary: 'bg-primary text-white hover:bg-black',
    ghost: 'text-muted hover:text-fg hover:bg-black/[0.05]',
    danger: 'bg-danger/90 text-white hover:bg-danger',
    outline: 'border border-border text-fg hover:bg-black/[0.05]',
  }[variant];
  return <button className={cn(base, sizes, variants, className)} {...rest} />;
}

// ---------- Portal Popover ----------
export function Popover({ anchor, onClose, children, align = 'left', className }: {
  anchor: DOMRect | { x: number; y: number } | null; onClose: () => void; children: React.ReactNode; align?: 'left' | 'right'; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [anchor, onClose]);
  if (!anchor) return null;
  const isRect = 'width' in anchor;
  const vh = window.innerHeight;
  // 锚点在视口下半部分时向上弹出，避免面板超出屏幕（输入框上的模式/档位/模型菜单）
  const anchorTop = isRect ? anchor.top : anchor.y;
  const anchorBottom = isRect ? anchor.bottom : anchor.y;
  const openUp = anchorTop > vh / 2;
  const style: React.CSSProperties = { position: 'fixed', zIndex: 1300 };
  if (openUp) { style.bottom = vh - anchorTop + 4; style.maxHeight = anchorTop - 12; }
  else { style.top = anchorBottom + 4; style.maxHeight = vh - anchorBottom - 12; }
  if (isRect && align === 'right') style.right = window.innerWidth - anchor.right;
  else style.left = isRect ? anchor.left : anchor.x;
  return createPortal(
    <div ref={ref} style={style}
      className={cn('bg-white border border-border rounded-lg shadow-xl p-1 min-w-40 overflow-auto', className)}>
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({ children, onClick, danger, disabled, hint }: { children: React.ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean; hint?: string }) {
  return (
    <button disabled={disabled} onClick={onClick}
      className={cn('w-full flex items-center justify-between gap-3 text-left px-2.5 py-1.5 rounded text-sm hover:bg-black/[0.06]', danger ? 'text-danger' : 'text-fg')}>
      <span className="truncate">{children}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </button>
  );
}
export function MenuSep() { return <div className="my-1 border-t border-border" />; }

// ---------- Context menu hook ----------
export function useContextMenu() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const open = useCallback((e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setPos({ x: e.clientX, y: e.clientY }); }, []);
  const close = useCallback(() => setPos(null), []);
  return { pos, open, close };
}

// ---------- Dropdown (select-like) ----------
export interface DropdownOption<T extends string> { value: T; label: React.ReactNode; desc?: string; icon?: React.ReactNode }
export function Dropdown<T extends string>({ value, options, onChange, renderValue, className, tone, compact, title, footer, minWidth = 200 }: {
  value: T; options: Array<DropdownOption<T>>; onChange: (v: T) => void; renderValue?: (v: T) => React.ReactNode; className?: string; title?: string;
  /** 触发按钮的配色类（替换默认的 muted/hover 灰底），用于模式/档位等带状态色的按钮 */
  tone?: string;
  /** 紧凑尺寸（22px 高、小圆角），用于带底色的状态按钮，避免色块过大 */
  compact?: boolean;
  /** 菜单底部附加项（如「模型管理」入口） */
  footer?: (close: () => void) => React.ReactNode; minWidth?: number;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const cur = options.find(o => o.value === value);
  const close = () => setRect(null);
  return (
    <>
      <button ref={btn} title={title} onClick={() => setRect(btn.current!.getBoundingClientRect())}
        className={cn('inline-flex items-center gap-1', compact ? 'h-[22px] px-1.5 rounded text-[11px]' : 'h-7 px-2 rounded-md text-xs', tone || 'text-muted hover:text-fg hover:bg-black/[0.05]', className)}>
        {renderValue ? renderValue(value) : <>{cur?.icon}{cur?.label ?? value}</>}
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.5" /></svg>
      </button>
      <Popover anchor={rect} onClose={close} className="py-1.5" >
        <div style={{ minWidth }}>
          {options.map(o => (
            <button key={o.value} onClick={() => { onChange(o.value); close(); }}
              className="w-full flex items-center gap-2.5 text-left px-3 py-1.5 rounded hover:bg-black/[0.05] text-sm">
              {o.icon && <span className="shrink-0 w-4 h-4 flex items-center justify-center">{o.icon}</span>}
              <span className="flex-1 min-w-0">
                <span className="block truncate">{o.label}</span>
                {o.desc && <span className="block text-xs text-muted">{o.desc}</span>}
              </span>
              {o.value === value && <svg width="14" height="14" viewBox="0 0 24 24" className="text-ok shrink-0"><path d="M5 12l5 5L20 7" stroke="currentColor" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </button>
          ))}
          {footer && <div className="mt-1 pt-1 border-t border-border">{footer(close)}</div>}
        </div>
      </Popover>
    </>
  );
}

// ---------- Toggle ----------
export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={() => onChange(!checked)} aria-checked={checked} role="switch"
      className={cn('relative inline-block w-9 h-5 shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-accent' : 'bg-[#d4d4d4]')}>
      <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform"
        style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }} />
    </button>
  );
}

// ---------- Modal / dialogs ----------
export function Modal({ open, onClose, title, children, width = 440 }: { open: boolean; onClose: () => void; title?: React.ReactNode; children: React.ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[1100] bg-black/30 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="bg-white border border-border rounded-xl shadow-2xl max-h-[85vh] flex flex-col" style={{ width }} onMouseDown={e => e.stopPropagation()}>
        {title && <div className="px-4 py-3 border-b border-border font-medium">{title}</div>}
        <div className="p-4 overflow-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

interface DialogReq {
  kind: 'prompt' | 'confirm';
  title: string; message?: string; defaultValue?: string; placeholder?: string; danger?: boolean; okText?: string;
  extra?: React.ReactNode;
  resolve: (v: string | boolean | null) => void;
}
const DialogCtx = createContext<{ prompt: (o: Omit<DialogReq, 'kind' | 'resolve'>) => Promise<string | null>; confirm: (o: Omit<DialogReq, 'kind' | 'resolve'>) => Promise<boolean> } | null>(null);

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = useState<DialogReq | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const prompt = useCallback((o: Omit<DialogReq, 'kind' | 'resolve'>) => new Promise<string | null>(resolve => { setValue(o.defaultValue || ''); setReq({ ...o, kind: 'prompt', resolve: v => resolve(v as string | null) }); }), []);
  const confirm = useCallback((o: Omit<DialogReq, 'kind' | 'resolve'>) => new Promise<boolean>(resolve => { setReq({ ...o, kind: 'confirm', resolve: v => resolve(!!v) }); }), []);
  useEffect(() => { if (req?.kind === 'prompt') setTimeout(() => inputRef.current?.select(), 0); }, [req]);
  const done = (v: string | boolean | null) => { req?.resolve(v); setReq(null); };
  return (
    <DialogCtx.Provider value={{ prompt, confirm }}>
      {children}
      <Modal open={!!req} onClose={() => done(req?.kind === 'prompt' ? null : false)} title={req?.title}>
        {req?.message && <p className="text-sm text-muted mb-3 whitespace-pre-wrap">{req.message}</p>}
        {req?.kind === 'prompt' && (
          <input ref={inputRef} value={value} onChange={e => setValue(e.target.value)} placeholder={req.placeholder}
            onKeyDown={e => { if (e.key === 'Enter') done(value.trim()); }}
            className="w-full h-9 px-3 rounded-md bg-bg border border-border text-sm focus:border-accent" />
        )}
        {req?.extra}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" onClick={() => done(req?.kind === 'prompt' ? null : false)}>{t('dialog.cancel')}</Button>
          <Button variant={req?.danger ? 'danger' : 'primary'} onClick={() => done(req?.kind === 'prompt' ? value.trim() : true)}>{req?.okText || t('dialog.ok')}</Button>
        </div>
      </Modal>
    </DialogCtx.Provider>
  );
}
export function useDialog() { return useContext(DialogCtx)!; }

// ---------- misc ----------
export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block h-3.5 w-3.5 rounded-full border-2 border-muted/40 border-t-accent animate-spin', className)} />;
}

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  }, []);
  return { copied, copy };
}

export function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86400_000) return `${Math.floor(d / 3600_000)} 小时前`;
  if (d < 7 * 86400_000) return `${Math.floor(d / 86400_000)} 天前`;
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}/${dt.getDate()}`;
}

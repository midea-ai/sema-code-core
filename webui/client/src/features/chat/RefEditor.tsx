/**
 * 输入框编辑器：contentEditable，把文本里的特定片段（@ 文件引用、开头的技能名）显示为不可编辑的内联标签。
 * 对外只暴露"全文 + 全文坐标光标"：value 始终是发给 core 的完整文本，getCaret/setCaret 都按全文偏移算，
 * Composer 里的 @ 弹层判定、翻历史、pendingCaret 等逻辑不需要知道标签的存在。
 *
 * 同步策略：键入时 DOM 是真相源（onInput 序列化后上报，不重建，避免打断 IME）；
 * 只有外部改值（补全 / 翻历史 / 发送清空）或标签集合变化时才按 parse 结果重建子节点并恢复光标。
 * 标签内容通过 portal 渲染到手工创建的 span 里，contentEditable 容器本身不交给 React 管理子节点。
 */
import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../common/ui';

export type EditorSegment = { type: 'text'; text: string } | { type: 'token'; raw: string; node: React.ReactNode };

export interface RefEditorHandle {
  focus(): void;
  /** 光标在全文中的偏移；编辑器没有焦点时返回文本末尾 */
  getCaret(): number;
  setCaret(pos: number): void;
}

interface Props {
  value: string;
  /** 把全文切成普通段 / 标签段；标签段的 raw 是序列化回全文时的字面量 */
  parse: (text: string) => EditorSegment[];
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** deleting：本次变化是删除（原生 delete* inputType 或整块删标签），上层据此不新开弹层 */
  onChange: (text: string, caret: number, deleting: boolean) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onKeyUp?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLDivElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLDivElement>) => void;
}

/** DOM → 全文：文本节点原样（nbsp 还原为空格），[data-raw] 取字面量，<br> 为换行（末尾占位的 data-tail 除外），块级子元素前补换行 */
function serialize(node: Node): string {
  let out = '';
  node.childNodes.forEach((n, i) => {
    if (n.nodeType === Node.TEXT_NODE) { out += (n.textContent || '').replace(/ /g, ' '); return; }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as HTMLElement;
    if (el.dataset.raw !== undefined) { out += el.dataset.raw; return; }
    if (el.tagName === 'BR') { if (el.dataset.tail === undefined) out += '\n'; return; }
    if (i > 0 && /^(DIV|P)$/.test(el.tagName)) out += '\n';
    out += serialize(el);
  });
  return out;
}

const tokensOf = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>('[data-raw]')).map(el => el.dataset.raw!);

/** 末尾常驻一个 <br>：文本以换行结尾时才能显示出空的最后一行 */
function ensureTail(root: HTMLElement) {
  const last = root.lastChild as HTMLElement | null;
  if (last && last.nodeType === Node.ELEMENT_NODE && last.tagName === 'BR' && last.dataset.tail !== undefined) return;
  const br = document.createElement('br');
  br.dataset.tail = '';
  root.appendChild(br);
}

interface PortalSlot { key: number; el: HTMLElement }
let slotSeq = 0;

export const RefEditor = forwardRef<RefEditorHandle, Props>(function RefEditor(
  { value, parse, disabled, placeholder, className, onChange, onKeyDown, onKeyUp, onClick, onBlur, onPaste }, ref,
) {
  const root = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<PortalSlot[]>([]);
  const composing = useRef(false);
  // 整块删标签后光标应落的全文偏移：DOM 里标签还在，重建时按 DOM 算出的光标会偏后，需强制指定
  const forcedCaret = useRef<number | null>(null);

  const getCaret = useCallback((): number => {
    const el = root.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || document.activeElement !== el) return value.length;
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return value.length;
    const pre = document.createRange();
    pre.setStart(el, 0);
    pre.setEnd(r.startContainer, r.startOffset);
    return serialize(pre.cloneContents()).length;
  }, [value.length]);

  const setCaret = useCallback((pos: number) => {
    const el = root.current;
    if (!el) return;
    const range = document.createRange();
    let count = 0, placed = false;
    // 只遍历一层：重建后的子节点就是 文本 / 标签 span / <br> 三种；浏览器额外包出来的 div 走末尾兜底
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        const len = n.textContent!.length;
        if (pos <= count + len) { range.setStart(n, pos - count); placed = true; break; }
        count += len;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const e = n as HTMLElement;
        const len = e.dataset.raw !== undefined ? e.dataset.raw.length : e.tagName === 'BR' && e.dataset.tail === undefined ? 1 : 0;
        if (e.dataset.tail !== undefined) break;
        if (pos <= count) { range.setStartBefore(e); placed = true; break; }
        if (pos <= count + len) { range.setStartAfter(e); placed = true; break; }
        count += len;
      }
    }
    if (!placed) {
      const tail = el.lastChild as HTMLElement | null;
      if (tail && tail.nodeType === Node.ELEMENT_NODE && (tail as HTMLElement).dataset.tail !== undefined) range.setStartBefore(tail);
      else range.setStart(el, el.childNodes.length);
    }
    range.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => root.current?.focus(),
    getCaret,
    setCaret: (pos: number) => { root.current?.focus(); setCaret(pos); },
  }), [getCaret, setCaret]);

  // 外部改值 / 标签集合变化 → 重建；键入产生的同文本不重建。IME 组合期间不动 DOM
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || composing.current) return;
    const segs = parse(value);
    const wantTokens = segs.filter(s => s.type === 'token').map(s => (s as { raw: string }).raw);
    const same = serialize(el) === value && wantTokens.join('\0') === tokensOf(el).join('\0');
    const forced = forcedCaret.current;
    forcedCaret.current = null;
    if (same) { ensureTail(el); if (forced !== null) setCaret(Math.min(forced, value.length)); return; }
    const focused = document.activeElement === el;
    const caret = forced !== null ? Math.min(forced, value.length) : focused ? Math.min(getCaret(), value.length) : null;
    el.replaceChildren();
    const next: PortalSlot[] = [];
    for (const s of segs) {
      if (s.type === 'text') { el.appendChild(document.createTextNode(s.text)); continue; }
      const span = document.createElement('span');
      span.contentEditable = 'false';
      span.dataset.raw = s.raw;
      span.className = 'inline-block align-top';
      el.appendChild(span);
      next.push({ key: ++slotSeq, el: span });
    }
    ensureTail(el);
    setSlots(next);
    if (caret !== null) setCaret(caret);
  }, [value, parse, getCaret, setCaret]);

  const emit = (deleting = false) => { const el = root.current; if (el) onChange(serialize(el), getCaret(), deleting); };

  /** 光标紧贴标签（Backspace 在标签后 / Delete 在标签前）时返回该标签的全文区间 */
  const adjacentToken = (key: string): { start: number; end: number } | null => {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed) return null;
    const caret = getCaret();
    let pos = 0;
    for (const s of parse(value)) {
      const len = s.type === 'text' ? s.text.length : s.raw.length;
      if (s.type === 'token' && (key === 'Backspace' ? pos + len === caret : pos === caret)) return { start: pos, end: pos + len };
      pos += len;
    }
    return null;
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    // 换行统一走 insertText：浏览器默认的 insertParagraph 会包 div，序列化虽兼容但光标计算会漂
    if (e.key === 'Enter') { e.preventDefault(); document.execCommand('insertText', false, '\n'); return; }
    // 光标紧贴标签：按全文模型整块删掉 raw 字面量，不依赖 Chromium 对 contentEditable=false 节点的原生删除
    //（原生删除有时只删掉一部分或让标签退化成明文逐字删）
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const tok = adjacentToken(e.key);
      if (!tok) return;
      e.preventDefault();
      forcedCaret.current = tok.start;
      onChange(value.slice(0, tok.start) + value.slice(tok.end), tok.start, true);
    }
  };
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    onPaste?.(e);
    if (e.defaultPrevented) return;
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  };

  // 标签内容按当前 parse 结果与 slot 顺序对应（重建后二者一致；组合期间可能短暂错位，compositionend 后重建纠正）
  const tokens = parse(value).filter(s => s.type === 'token') as Extract<EditorSegment, { type: 'token' }>[];

  return (
    <>
      <div ref={root} contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-multiline="true" aria-disabled={disabled || undefined}
        data-placeholder={placeholder} data-empty={value === '' ? '' : undefined}
        className={cn('ref-editor relative outline-none', className)}
        onInput={e => emit(((e.nativeEvent as InputEvent).inputType || '').startsWith('delete'))}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; emit(); }}
        onBeforeInput={e => {
          const ie = e.nativeEvent as InputEvent;
          if (ie.inputType === 'insertParagraph' || ie.inputType === 'insertLineBreak') { e.preventDefault(); document.execCommand('insertText', false, '\n'); }
        }}
        onKeyDown={handleKeyDown} onKeyUp={onKeyUp} onClick={onClick} onBlur={onBlur} onPaste={handlePaste} />
      {slots.map((s, i) => tokens[i] ? createPortal(tokens[i].node, s.el, String(s.key)) : null)}
    </>
  );
});

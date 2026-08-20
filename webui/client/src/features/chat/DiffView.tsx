import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/http';
import hljs from 'highlight.js/lib/common';
import type { Hunk } from '../../../../shared/types';
import { cn } from '../../common/ui';
import { langOf, escapeHtml } from '../../common/text';

/** 折叠态最大高度（px） */
const COLLAPSED_MAX_PX = 100;
/** 超过该行数不做语法高亮 */
const MAX_HL_LINES = 2000;
/** 词级 diff：改动占比超过该值视为整行重写，不做词级高亮 */
const WORD_DIFF_MAX_CHANGE_RATIO = 0.5;

type RowKind = 'add' | 'del' | 'ctx' | 'sep';
interface Row { kind: RowKind; lineNo?: number; text: string; marks?: Array<[number, number]> }

/**
 * 结构化 diff（Hunk[]）渲染：行号 + 符号 + 语法高亮正文；相邻增删行做词级高亮。
 * collapsible 时默认折叠到 COLLAPSED_MAX_PX（底部渐隐 + 「展开」），内容超长时才出现按钮。
 */
export const DiffView = memo(function DiffView({ patch: rawPatch, path, sessionId, maxLines, collapsible = false, className }: {
  patch: Hunk[]; path?: string; sessionId?: string; maxLines?: number; collapsible?: boolean; className?: string;
}) {
  const patch = useFullNewFilePatch(rawPatch, path, sessionId);
  const rows = useMemo(() => computeWordDiffs(toRows(patch)), [patch]);
  const shown = maxLines ? rows.slice(0, maxLines) : rows;
  const hidden = rows.length - shown.length;
  const html = useMemo(() => highlightRows(shown, path ? langOf(path) : undefined), [shown, path]);

  const { ref, expanded, setExpanded, overflowing, collapsed } = useCollapsible(collapsible, rows);

  return (
    <div className={cn('font-mono text-[12px] leading-5 rounded-md border border-border bg-code overflow-hidden', className)}>
      <div ref={ref} className={cn('overflow-x-auto', collapsed && 'diff-collapsed')} style={collapsed ? { maxHeight: COLLAPSED_MAX_PX } : undefined}>
        <table className="w-full border-collapse">
          <colgroup><col className="w-10" /><col className="w-4" /><col /></colgroup>
          <tbody>
            {shown.map((r, i) => r.kind === 'sep' ? (
              <tr key={i}><td colSpan={3} className="h-1.5 diff-sep" /></tr>
            ) : (
              <tr key={i} className={r.kind === 'add' ? 'bg-add' : r.kind === 'del' ? 'bg-del' : ''}>
                <td className="text-right pr-1 text-muted/70 select-none align-top">{r.lineNo ?? ''}</td>
                <td className={cn('text-center select-none align-top', r.kind === 'add' ? 'text-ok' : r.kind === 'del' ? 'text-danger' : 'text-transparent')}>{r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ''}</td>
                <td className="pl-2 pr-3 whitespace-pre-wrap break-all align-top hljs !bg-transparent !p-0 !pl-2 !pr-3" dangerouslySetInnerHTML={{ __html: html[i] || '&#x200B;' }} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hidden > 0 && !collapsed && <div className="px-2 py-1 text-xs text-muted border-t border-border">… 还有 {hidden} 行</div>}
      {collapsible && overflowing && <CollapseToggle expanded={expanded} onToggle={() => setExpanded(v => !v)} />}
    </div>
  );
});

/** 新建文件的事件里只带前几行预览（lines < newLines）：有会话时按路径读取当前文件内容，补成完整的「全部新增」hunk */
function isTruncatedNew(patch: Hunk[]) {
  return patch.length === 1 && patch[0].oldLines === 0 && patch[0].newLines > (patch[0].lines || []).length;
}
/** 以预览 patch 对象为键缓存（同一事件复用；新事件重新读取，避免文件后续被改后显示过期内容） */
const fullFileCache = new WeakMap<Hunk[], Hunk[]>();
function useFullNewFilePatch(patch: Hunk[], path?: string, sessionId?: string): Hunk[] {
  const need = !!sessionId && !!path && isTruncatedNew(patch);
  const [full, setFull] = useState<Hunk[] | null>(() => (need && fullFileCache.get(patch)) || null);
  useEffect(() => {
    if (!need) return;
    const cached = fullFileCache.get(patch);
    if (cached) { setFull(cached); return; }
    let alive = true;
    api<{ content: string; binary: boolean }>('POST', `/api/sessions/${sessionId}/file`, { path })
      .then(d => {
        if (!alive || d.binary) return;
        const lines = d.content.split(/\r?\n/).map(l => '+' + l);
        const h: Hunk[] = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines }];
        fullFileCache.set(patch, h);
        setFull(h);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [need, patch, sessionId, path]);
  return need && full ? full : patch;
}

// ==================== 折叠（DiffView / CodeView 共用） ====================

/** 内容超过 COLLAPSED_MAX_PX 时折叠；deps 变化时重新测量 */
export function useCollapsible(enabled: boolean, deps: unknown) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const measure = () => setOverflowing(el.scrollHeight > COLLAPSED_MAX_PX + 1);
    measure();
    const ob = new ResizeObserver(measure);
    ob.observe(el);
    return () => ob.disconnect();
  }, [enabled, deps]);
  return { ref, expanded, setExpanded, overflowing, collapsed: enabled && overflowing && !expanded };
}

export function CollapseToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={e => { e.stopPropagation(); onToggle(); }} className="block w-full text-left px-2 py-1 text-xs text-muted hover:text-fg hover:underline">
      {expanded ? '收起' : '展开'}
    </button>
  );
}

/** 通用折叠容器：任意内容（如 markdown）超长时折叠到固定高度，底部渐隐 + 「展开/收起」 */
export function Collapsible({ children, deps, className }: { children: React.ReactNode; deps?: unknown; className?: string }) {
  const { ref, expanded, setExpanded, overflowing, collapsed } = useCollapsible(true, deps);
  return (
    <div className={className}>
      <div ref={ref} className={cn(collapsed && 'diff-collapsed')} style={collapsed ? { maxHeight: COLLAPSED_MAX_PX } : undefined}>{children}</div>
      {overflowing && <CollapseToggle expanded={expanded} onToggle={() => setExpanded(v => !v)} />}
    </div>
  );
}

/** 代码片段（如 shell 命令）：语法高亮 + 超长折叠 */
export const CodeView = memo(function CodeView({ code, lang = 'bash', collapsible = true, className }: { code: string; lang?: string; collapsible?: boolean; className?: string }) {
  const html = useMemo(() => highlightBlock(code.split('\n'), lang).join('\n'), [code, lang]);
  const { ref, expanded, setExpanded, overflowing, collapsed } = useCollapsible(collapsible, code);
  return (
    <div className={cn('font-mono text-[12px] leading-5 rounded-md border border-border bg-code overflow-hidden', className)}>
      <div ref={ref} className={cn('overflow-x-auto', collapsed && 'diff-collapsed')} style={collapsed ? { maxHeight: COLLAPSED_MAX_PX } : undefined}>
        <pre className="hljs !bg-transparent !p-2 whitespace-pre-wrap break-all" dangerouslySetInnerHTML={{ __html: html || '&#x200B;' }} />
      </div>
      {collapsible && overflowing && <CollapseToggle expanded={expanded} onToggle={() => setExpanded(v => !v)} />}
    </div>
  );
});

// ==================== 行构造 ====================

function toRows(patch: Hunk[]): Row[] {
  const rows: Row[] = [];
  patch.forEach((h, i) => {
    if (i > 0) rows.push({ kind: 'sep', text: '' });
    let o = h.oldStart, n = h.newStart;
    for (const line of h.lines || []) {
      const c = line[0];
      const text = line.slice(1);
      if (c === '+') rows.push({ kind: 'add', lineNo: n++, text });
      else if (c === '-') rows.push({ kind: 'del', lineNo: o++, text });
      else if (c === '\\') continue;
      else { o++; rows.push({ kind: 'ctx', lineNo: n++, text }); }
    }
  });
  return rows;
}

// ==================== 词级 diff ====================

const tokenize = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) || [];

/** 基于 token 的 LCS，返回 [aRanges, bRanges]：分别为 a/b 中被改动的字符区间 */
function wordDiff(a: string, b: string): { aMarks: Array<[number, number]>; bMarks: Array<[number, number]>; changed: number; total: number } {
  const ta = tokenize(a), tb = tokenize(b);
  const n = ta.length, m = tb.length;
  // LCS 长度表（行内 token 数通常很小）
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const aMarks: Array<[number, number]> = [], bMarks: Array<[number, number]> = [];
  let i = 0, j = 0, pa = 0, pb = 0, changed = 0;
  const push = (arr: Array<[number, number]>, s: number, e: number) => { const last = arr[arr.length - 1]; if (last && last[1] === s) last[1] = e; else arr.push([s, e]); };
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { pa += ta[i].length; pb += tb[j].length; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(aMarks, pa, pa + ta[i].length); changed += ta[i].length; pa += ta[i].length; i++; }
    else { push(bMarks, pb, pb + tb[j].length); changed += tb[j].length; pb += tb[j].length; j++; }
  }
  for (; i < n; i++) { push(aMarks, pa, pa + ta[i].length); changed += ta[i].length; pa += ta[i].length; }
  for (; j < m; j++) { push(bMarks, pb, pb + tb[j].length); changed += tb[j].length; pb += tb[j].length; }
  return { aMarks, bMarks, changed, total: a.length + b.length };
}

/** 相邻的「若干删除行 + 若干新增行」按顺序两两配对做词级 diff */
function computeWordDiffs(rows: Row[]): Row[] {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== 'del') { i++; continue; }
    const delStart = i;
    while (i < rows.length && rows[i].kind === 'del') i++;
    const addStart = i;
    while (i < rows.length && rows[i].kind === 'add') i++;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k++) {
      const d = rows[delStart + k], a = rows[addStart + k];
      const r = wordDiff(d.text, a.text);
      if (r.total === 0 || r.changed / r.total <= WORD_DIFF_MAX_CHANGE_RATIO) { d.marks = r.aMarks; a.marks = r.bMarks; }
    }
  }
  return rows;
}

// ==================== 语法高亮 ====================

/** 把 hljs 输出按换行拆成多行，跨行的 span 在行尾闭合、下一行重新打开 */
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let cur = '';
  for (let i = 0; i < html.length;) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) { cur += html.slice(i); break; }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</span')) stack.pop(); else if (tag.startsWith('<span')) stack.push(tag);
      cur += tag; i = end + 1;
    } else if (ch === '\n') {
      cur += '</span>'.repeat(stack.length);
      lines.push(cur);
      cur = stack.join('');
      i++;
    } else { cur += ch; i++; }
  }
  cur += '</span>'.repeat(stack.length);
  lines.push(cur);
  return lines;
}

function highlightBlock(contents: string[], lang?: string): string[] {
  if (!lang || !contents.length || contents.length > MAX_HL_LINES || !hljs.getLanguage(lang)) return contents.map(escapeHtml);
  try {
    const lines = splitHighlightedLines(hljs.highlight(contents.join('\n'), { language: lang, ignoreIllegals: true }).value);
    while (lines.length < contents.length) lines.push('');
    return lines.slice(0, contents.length);
  } catch { return contents.map(escapeHtml); }
}

/** 在已高亮的 HTML 上叠加词级高亮 span：遇到 </span> 先闭合再重开，保证嵌套合法 */
function applyMarks(html: string, marks: Array<[number, number]>, kind: 'add' | 'del'): string {
  if (!marks.length) return html;
  const cls = `diff-word-${kind}`;
  const inRange = (p: number) => marks.some(([s, e]) => p >= s && p < e);
  let out = '', pos = 0, open = false;
  const openTag = () => { out += `<span class="${cls}">`; open = true; };
  const closeTag = () => { out += '</span>'; open = false; };
  for (let i = 0; i < html.length;) {
    if (html[i] === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) { out += html.slice(i); break; }
      const tag = html.slice(i, end + 1);
      i = end + 1;
      if (tag === '</span>') { if (open) closeTag(); out += tag; if (inRange(pos)) openTag(); }
      else out += tag;
      continue;
    }
    let ch = html[i], step = 1;
    if (ch === '&') { const semi = html.indexOf(';', i); if (semi !== -1 && semi - i <= 8) { ch = html.slice(i, semi + 1); step = semi + 1 - i; } }
    if (inRange(pos) && !open) openTag(); else if (!inRange(pos) && open) closeTag();
    out += ch; i += step; pos++;
  }
  if (open) closeTag();
  return out;
}

/** 旧视图（ctx+del）与新视图（ctx+add）分别整块高亮，保证多行结构着色正确；ctx 取新视图结果 */
function highlightRows(rows: Row[], lang?: string): string[] {
  const oldIdx: number[] = [], newIdx: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === 'ctx') { oldIdx.push(i); newIdx.push(i); }
    else if (r.kind === 'del') oldIdx.push(i);
    else if (r.kind === 'add') newIdx.push(i);
  });
  const oldHL = highlightBlock(oldIdx.map(i => rows[i].text), lang);
  const newHL = highlightBlock(newIdx.map(i => rows[i].text), lang);
  const out: string[] = new Array(rows.length).fill('');
  oldIdx.forEach((ri, k) => { out[ri] = oldHL[k]; });
  newIdx.forEach((ri, k) => { out[ri] = newHL[k]; });
  rows.forEach((r, i) => { if ((r.kind === 'add' || r.kind === 'del') && r.marks) out[i] = applyMarks(out[i], r.marks, r.kind); });
  return out;
}

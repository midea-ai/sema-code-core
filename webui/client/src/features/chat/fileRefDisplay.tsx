/**
 * @ 文件引用的显示：把文本里的 `@path` / `@"path with space"` / `@path:13-17` 渲染成「文件图标 + 文件名」芯片，
 * 输入框（RefEditor）与用户气泡共用。只影响显示，发给 core 的文本仍是原始 `@...` 字面量。
 */
import type { MouseEventHandler, ReactNode } from 'react';
import { FileIcon } from '../../common/fileicon/FileIcon';
import { cn } from '../../common/ui';

/** 与 core util/fileReference 的解析正则一致：@ 前须为行首或边界字符，引用体为双引号串或连续非边界字符 */
const BOUNDARY = '\\s。，、；：！？“”‘’「」『』（）《》〈〉【】,;!?';
export const FILE_REF_RE = new RegExp(`(?:^|(?<=[${BOUNDARY}]))@(?:"([^"]+)"|([^${BOUNDARY}]+))`, 'g');

export interface RefSegment {
  type: 'ref';
  /** 原始字面量（含 @ 与引号），序列化回全文时用 */
  raw: string;
  /** 去掉行号后缀的路径 */
  path: string;
  line?: number;
  endLine?: number;
  isDirectory: boolean;
}
export type TextSegment = { type: 'text'; text: string };
export type Segment = TextSegment | RefSegment;

/** 解析引用体的行号后缀：`a.ts:13` / `a.ts:13-17`；解析不出行号时整个当作路径（与 core 一致） */
function parseRef(body: string): Pick<RefSegment, 'path' | 'line' | 'endLine'> {
  const m = body.match(/^(.+):(\d+)(?:-(\d+))?$/);
  if (!m) return { path: body };
  const line = Math.max(1, parseInt(m[2], 10));
  return { path: m[1], line, endLine: m[3] ? Math.max(line, parseInt(m[3], 10)) : undefined };
}

/**
 * 把文本切成普通段与引用段（无引用时返回单个普通段；空文本返回空数组）。
 * typingAt（输入框用）：@ 选择器正打开的那个引用的 @ 偏移，该引用视为"正在输入"保持为普通文本，
 * 否则敲到 `@sr` 就被换成芯片，@ 弹层的 query 就没法继续编辑了。
 * 不按"引用顶到文本末尾"判定：删掉芯片后面的空格时芯片会顶到末尾，那样会被打回明文然后逐字删
 */
export function splitFileRefs(text: string, typingAt: number | null = null): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(FILE_REF_RE)) {
    const idx = m.index!;
    if (idx === typingAt) continue;
    if (idx > last) out.push({ type: 'text', text: text.slice(last, idx) });
    const body = m[1] ?? m[2]!;
    out.push({ type: 'ref', raw: m[0], ...parseRef(body), isDirectory: /[\\/]$/.test(body) });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** 服务端 stat 用的路径键：去掉尾部分隔符（与 fileRefs.parsePathRef 一致） */
export const refStatPath = (path: string) => path.replace(/[\\/]+$/, '') || path;

/** 文本里所有引用的 stat 键（去重），交给 usePathStats 批量确认存在性 */
export function refPaths(text: string, typingAt: number | null = null): string[] {
  const out = new Set<string>();
  for (const s of splitFileRefs(text, typingAt)) if (s.type === 'ref') out.add(refStatPath(s.path));
  return [...out];
}

/** 芯片上显示的名字：basename（目录保留尾部 /），带行号时追加 `:13-17` */
export function refLabel(seg: RefSegment): string {
  const trimmed = seg.path.replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() || seg.path;
  const name = seg.isDirectory ? `${base}/` : base;
  return seg.line ? `${name}:${seg.line}${seg.endLine ? `-${seg.endLine}` : ''}` : name;
}

/** 文件高亮统一图标尺寸：输入框芯片、用户气泡、@ 文件/命令面板、Markdown 文件引用共用 */
export const FILE_LABEL_ICON = 15;

/**
 * 文件高亮的统一外形：图标 + 名字（无底色），四处（输入框芯片、用户气泡、@ 面板、Markdown 引用）都走这里，
 * 只有名字内容与颜色由调用方决定。
 * 高度取整行行高并 align-top 贴满行框，图标/文字在行框内居中，与父级文字的垂直位置一致（align-middle 按 x-height 算会偏高；
 * 行内流式 + vertical-align 下沉的写法与之差半像素，且行高越大图标越显得偏下，故统一用这一种）。
 * 图标默认按文件类型上色，传 color="currentColor" 时跟随文字色。
 * 名字默认加粗（正文里作为高亮），plain 时用正常字重（列表行里每行都是文件，加粗反而突兀）。
 */
export function FileLabel({ path, isDirectory, label, size = FILE_LABEL_ICON, color, plain, className, title, onMouseDown, onClick }: {
  path: string; isDirectory?: boolean; label: ReactNode; size?: number; color?: string; plain?: boolean; className?: string; title?: string;
  onMouseDown?: MouseEventHandler; onClick?: MouseEventHandler;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 h-[1lh] align-top whitespace-nowrap max-w-full', className)}
      title={title} onMouseDown={onMouseDown} onClick={onClick}>
      <FileIcon fileName={path} isDirectory={isDirectory} size={size} color={color} />
      <span className={cn('truncate', !plain && 'font-medium')}>{label}</span>
    </span>
  );
}

/**
 * @ 引用芯片（输入框与用户气泡共用）：名字只显示 basename；有 onOpen 时可点击。
 * 图标与文字统一用强调色（与全局链接高亮同色），不按文件类型上色，避免正文里色彩杂乱。
 */
export function FileRefChip({ seg, className, onOpen }: { seg: RefSegment; className?: string; onOpen?: (seg: RefSegment) => void }) {
  return (
    <FileLabel path={seg.path} isDirectory={seg.isDirectory} label={refLabel(seg)} color="currentColor" title={seg.path}
      className={cn('text-accent', onOpen && 'cursor-pointer', className)}
      onMouseDown={onOpen ? e => { e.preventDefault(); e.stopPropagation(); } : undefined}
      onClick={onOpen ? e => { e.stopPropagation(); onOpen(seg); } : undefined} />
  );
}

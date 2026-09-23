/**
 * @ 文件引用的显示：把文本里的 `@path` / `@"path with space"` / `@path:13-17` 渲染成「文件图标 + 文件名」芯片，
 * 输入框（RefEditor）与用户气泡共用。只影响显示，发给 core 的文本仍是原始 `@...` 字面量。
 */
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

/**
 * 图标 + 文件名，内联在文字中（无底色，布局对齐 SkillLabel）；有 onOpen 时可点击。
 * 图标与文字统一用强调色（与全局链接高亮同色），不按文件类型上色，避免正文里色彩杂乱。
 * 高度取整行行高并 align-top 贴满行框，图标/文字在行框内居中，与父级文字的垂直位置一致（align-middle 按 x-height 算会偏高）
 */
export function FileRefChip({ seg, size = 15, className, onOpen }: { seg: RefSegment; size?: number; className?: string; onOpen?: (seg: RefSegment) => void }) {
  return (
    <span className={cn('inline-flex items-center gap-1 h-[1lh] align-top whitespace-nowrap max-w-full text-accent', onOpen && 'cursor-pointer', className)}
      title={seg.path}
      onMouseDown={onOpen ? e => { e.preventDefault(); e.stopPropagation(); } : undefined}
      onClick={onOpen ? e => { e.stopPropagation(); onOpen(seg); } : undefined}>
      <FileIcon fileName={seg.path} isDirectory={seg.isDirectory} size={size} color="currentColor" />
      <span className="font-medium truncate">{refLabel(seg)}</span>
    </span>
  );
}

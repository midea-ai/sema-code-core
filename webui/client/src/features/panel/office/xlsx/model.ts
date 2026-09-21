/**
 * 表格渲染模型：纯数据、不碰 DOM，xlsx 与 csv 共用（日后要挪进 Worker 可原样搬）。
 * 行列下标一律从 0 开始；尺寸单位是 100% 缩放下的 px，缩放由网格渲染时统一乘。
 */
import type { ChartSpec } from './charts';
import { XlsxColor, resolveColor } from './colors';
import { dateToSerial, formatNumber } from './format';
import { Calc, isMissing } from './formulas';

export interface Border { w: number; style: 'solid' | 'dashed' | 'dotted' | 'double'; color: string }
export type Borders = Partial<Record<'t' | 'r' | 'b' | 'l', Border>>;
export interface CellStyle {
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean;
  color?: string; size?: number; font?: string; fill?: string;
  hAlign?: 'left' | 'center' | 'right'; vAlign?: 'top' | 'middle' | 'bottom'; wrap?: boolean; indent?: number;
  border?: Borders;
}
export interface CellModel {
  text: string;
  /** 公式栏内容：公式带 =，数值为未格式化的原值 */
  input: string;
  /** styles 下标，0 = 无样式 */
  s: number;
  /** 未指定水平对齐时的默认对齐：数值靠右、布尔 / 错误居中 */
  num?: boolean; center?: boolean;
  /** 数字格式里的条件色（如负数红字），覆盖字体色 */
  color?: string;
}
export interface Merge { r1: number; c1: number; r2: number; c2: number; border?: Borders }
/** 浮动对象（图片 / 图表）的像素矩形；图表解析不出定义时 chart 为空，只画占位框 */
export interface Anchor { kind: 'image' | 'chart'; x: number; y: number; w: number; h: number; src?: string; chart?: ChartSpec }
/** drawing 里的原始锚点：行列下标 + EMU 偏移 */
export interface RawAnchor { from: { col: number; colOff: number; row: number; rowOff: number }; to?: { col: number; colOff: number; row: number; rowOff: number }; ext?: { width: number; height: number } }

export interface SheetModel {
  name: string; rowCount: number; colCount: number;
  /** 前缀和：colX[c] 是第 c 列左边缘，长度 colCount+1；rowY 同理 */
  colX: number[]; rowY: number[];
  /** 稀疏：cells[r]?.[c] */
  cells: (CellModel | undefined)[][];
  styles: CellStyle[];
  merges: Merge[];
  /** cellKey(r,c) → merges 下标，覆盖合并区内的每个格子 */
  mergeAt: Map<number, number>;
  anchors: Anchor[];
  gridLines: boolean;
  tabColor?: string;
  /** 行数超过上限被截断 */
  capped?: boolean;
}

export const MAX_ROWS = 500000; // 再多总高度会逼近浏览器的元素尺寸上限（放大后更甚）
const MIN_ROWS = 50, MIN_COLS = 26;
const DEF_COL_W = 64, DEF_ROW_H = 20;
const EMU = 9525;

export const cellKey = (r: number, c: number) => r * 16384 + c;

/** 列号 → 字母（0 → A，26 → AA） */
export function colName(c: number): string {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

export function prefixSum(sizes: number[]): number[] {
  const out = new Array<number>(sizes.length + 1);
  out[0] = 0;
  for (let i = 0; i < sizes.length; i++) out[i + 1] = out[i] + sizes[i];
  return out;
}

export function indexMerges(merges: Merge[]): Map<number, number> {
  const at = new Map<number, number>();
  merges.forEach((m, i) => { for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) at.set(cellKey(r, c), i); });
  return at;
}

export interface BuildCtx {
  numfmt: typeof import('numfmt'); theme: string[]; date1904: boolean; images: (id: string | number) => string | undefined;
  /** 公式重算器：工作簿里有缺缓存值的公式时才有 */
  calc?: Calc;
}

const BORDER_W: Record<string, number> = { medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, thick: 3, double: 3 };
function toBorder(b: any, theme: string[]): Border | undefined {
  if (!b?.style) return undefined;
  const style = b.style === 'double' ? 'double' : /dot|hair/i.test(b.style) && !/dash/i.test(b.style) ? 'dotted' : /dash/i.test(b.style) ? 'dashed' : 'solid';
  return { w: BORDER_W[b.style] || 1, style, color: resolveColor(b.color, theme) || '#000000' };
}
function toBorders(b: any, theme: string[]): Borders | undefined {
  if (!b) return undefined;
  const out: Borders = { t: toBorder(b.top, theme), r: toBorder(b.right, theme), b: toBorder(b.bottom, theme), l: toBorder(b.left, theme) };
  return out.t || out.r || out.b || out.l ? out : undefined;
}

function toStyle(st: any, theme: string[]): CellStyle {
  const out: CellStyle = {};
  const f = st.font;
  if (f) {
    if (f.bold) out.bold = true;
    if (f.italic) out.italic = true;
    if (f.underline && f.underline !== 'none') out.underline = true;
    if (f.strike) out.strike = true;
    if (f.size && f.size !== 11) out.size = f.size;
    if (f.name) out.font = f.name;
    const c = resolveColor(f.color as XlsxColor, theme);
    if (c && c !== '#000000') out.color = c;
  }
  const fill = st.fill;
  // solid 填充的颜色在 fgColor（不是 bgColor）；其它图案近似取 fgColor；渐变取首个色标
  if (fill?.type === 'pattern' && fill.pattern !== 'none') out.fill = resolveColor(fill.fgColor, theme);
  else if (fill?.type === 'gradient') out.fill = resolveColor(fill.stops?.[0]?.color, theme);
  const a = st.alignment;
  if (a) {
    if (a.horizontal === 'center' || a.horizontal === 'centerContinuous') out.hAlign = 'center';
    else if (a.horizontal === 'left' || a.horizontal === 'right') out.hAlign = a.horizontal;
    if (a.vertical === 'top' || a.vertical === 'middle') out.vAlign = a.vertical;
    if (a.wrapText) out.wrap = true;
    if (a.indent) out.indent = a.indent;
  }
  const border = toBorders(st.border, theme);
  if (border) out.border = border;
  if (!out.fill) delete out.fill;
  return out;
}

/** 单元格值 → 显示文本 / 公式栏内容 */
function display(cell: any, ctx: BuildCtx): Omit<CellModel, 's'> {
  const formula: string | undefined = cell.type === 6 ? cell.formula : undefined; // ValueType.Formula；getter 已展开共享公式
  let v = formula !== undefined ? cell.result : cell.value;
  // 公式没有缓存值（文件没被 Excel 算过）：现算
  if (formula !== undefined && isMissing(v) && ctx.calc) v = ctx.calc(cell.worksheet.name, cell.row, cell.col);
  let out: Omit<CellModel, 's'>;
  if (v instanceof Date) v = dateToSerial(v, ctx.date1904);
  if (v == null) out = { text: '', input: '' };
  else if (typeof v === 'number') { const f = formatNumber(ctx.numfmt, cell.numFmt, v); out = { text: f.text, color: f.color, input: String(v), num: true }; }
  else if (typeof v === 'boolean') { const s = v ? 'TRUE' : 'FALSE'; out = { text: s, input: s, center: true }; }
  else if (typeof v === 'string') out = { text: v, input: v };
  else if (v.error) out = { text: v.error, input: v.error, center: true };
  else {
    // 富文本 / 超链接（超链接的 text 也可能是富文本）；首期不分 run 着色
    const t = v.richText ?? v.text?.richText;
    const s: string = Array.isArray(t) ? t.map((x: any) => x.text).join('') : String(v.text ?? '');
    out = { text: s, input: s };
  }
  if (formula !== undefined) out.input = `=${formula}`;
  // 日期的公式栏显示格式化后的文本（原值是序列号，没有可读性）
  else if (out.num && cell.type === 4) out.input = out.text;
  return out;
}

/** ExcelJS worksheet → 渲染模型；floats 是 ExcelJS 之外读到的浮动对象（图表占位、它解析不了的 drawing 里的图片） */
export function buildSheetModel(ws: any, ctx: BuildCtx, floats: Array<RawAnchor & Pick<Anchor, 'kind' | 'src' | 'chart'>> = []): SheetModel {
  // 样式去重：ExcelJS 对同一 xf 复用同一个 style 对象，先按引用命中，再按转换后的内容合并
  const styles: CellStyle[] = [{}];
  const byRef = new WeakMap<object, number>();
  const byKey = new Map<string, number>([['{}', 0]]);
  const styleOf = (st: any): number => {
    if (!st) return 0;
    let i = byRef.get(st);
    if (i === undefined) {
      const conv = toStyle(st, ctx.theme), key = JSON.stringify(conv);
      i = byKey.get(key);
      if (i === undefined) { i = styles.length; styles.push(conv); byKey.set(key, i); }
      byRef.set(st, i);
    }
    return i;
  };

  // eachRow / eachCell 会跳过「只有样式没有值」的行和格子（表头底色、边框框线就靠它们），所以直接走内部数组
  const rows: any[] = ws._rows || [];
  const capped = rows.length > MAX_ROWS;
  let rowCount = Math.min(MAX_ROWS, Math.max(rows.length, MIN_ROWS));
  let colCount = MIN_COLS;
  const defH = ws.properties?.defaultRowHeight ? ws.properties.defaultRowHeight * 4 / 3 : DEF_ROW_H;
  const cells: (CellModel | undefined)[][] = [];
  const rowH: number[] = new Array(rowCount).fill(defH);
  for (let r = 0; r < rowCount; r++) {
    const row = rows[r];
    if (!row) continue;
    let maxPt = 11, lines = 1;
    const out: (CellModel | undefined)[] = [];
    for (const cell of row._cells as any[]) {
      if (!cell) continue;
      const c = cell.col - 1;
      if (c + 1 > colCount) colCount = c + 1;
      if (cell.type === 1) continue; // ValueType.Merge：合并区的非主格，由主格覆盖
      const s = styleOf(cell.style);
      const d = display(cell, ctx);
      if (!d.text && s === 0) continue;
      out[c] = { ...d, s };
      if (d.text) {
        const st = styles[s];
        if (st.size && st.size > maxPt) maxPt = st.size;
        if (st.wrap && d.text.includes('\n')) lines = Math.max(lines, d.text.split('\n').length);
      }
    }
    if (out.length) cells[r] = out;
    // 行高：显式值优先；没有时（openpyxl 等不写自动行高）按字号和显式换行数估一个
    if (row.hidden) rowH[r] = 0;
    else if (row.height) rowH[r] = row.height * 4 / 3;
    else rowH[r] = Math.max(defH, Math.ceil(maxPt * 4 / 3 * 1.3) * lines);
  }

  const merges: Merge[] = [];
  for (const m of Object.values(ws._merges || {}) as any[]) {
    if (!m || m.top > rowCount) continue;
    const mg: Merge = { r1: m.top - 1, c1: m.left - 1, r2: Math.min(m.bottom, rowCount) - 1, c2: m.right - 1 };
    if (mg.c2 + 1 > colCount) colCount = mg.c2 + 1;
    // 合并区的外框：左 / 上取主格，右 / 下取右下角那个格子（Excel 就是这么分摊存的）
    const tl = toBorders(ws.findCell(m.top, m.left)?.style?.border, ctx.theme);
    const br = toBorders(ws.findCell(m.bottom, m.right)?.style?.border, ctx.theme);
    if (tl || br) mg.border = { t: tl?.t, l: tl?.l, r: br?.r, b: br?.b };
    merges.push(mg);
  }

  const raws = [...floats];
  for (const img of (ws.getImages?.() || []) as any[]) {
    const tl = img.range?.tl, br = img.range?.br;
    if (!tl) continue;
    const pos = (a: any) => ({ col: a.nativeCol, colOff: a.nativeColOff, row: a.nativeRow, rowOff: a.nativeRowOff });
    raws.push({ kind: 'image', src: ctx.images(img.imageId), from: pos(tl), to: br ? pos(br) : undefined, ext: img.range.ext });
  }
  for (const a of raws) {
    const end = a.to || a.from;
    colCount = Math.max(colCount, end.col + 2);
    rowCount = Math.min(MAX_ROWS, Math.max(rowCount, end.row + 2));
  }
  while (rowH.length < rowCount) rowH.push(defH);

  const defW = ws.properties?.defaultColWidth ? Math.round(ws.properties.defaultColWidth * 7 + 5) : DEF_COL_W;
  const colW: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const col = ws._columns?.[c];
    // 列宽单位是「默认字体下的字符数」，按最大数字宽 7px 换算
    colW.push(col?.hidden ? 0 : col?.width ? Math.round(col.width * 7 + 5) : defW);
  }
  const colX = prefixSum(colW), rowY = prefixSum(rowH);

  const at = (p: RawAnchor['from']) => ({ x: (colX[Math.min(p.col, colCount)] ?? 0) + p.colOff / EMU, y: (rowY[Math.min(p.row, rowCount)] ?? 0) + p.rowOff / EMU });
  const anchors: Anchor[] = raws.map(a => {
    const p = at(a.from), q = a.to ? at(a.to) : null;
    return { kind: a.kind, src: a.src, chart: a.chart, x: p.x, y: p.y, w: q ? q.x - p.x : a.ext?.width || 0, h: q ? q.y - p.y : a.ext?.height || 0 };
  }).filter(a => a.w > 0 && a.h > 0);

  return {
    name: ws.name, rowCount, colCount, colX, rowY, cells, styles, merges, mergeAt: indexMerges(merges), anchors,
    gridLines: ws.views?.[0]?.showGridLines !== false,
    tabColor: resolveColor(ws.properties?.tabColor, ctx.theme),
    capped,
  };
}

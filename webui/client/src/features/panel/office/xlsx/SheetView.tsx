import { useEffect, useState } from 'react';
import { cn, Spinner } from '../../../../common/ui';
import { t } from '../../../../i18n';
import { loadExcel, loadFormula } from '../loaders';
import { viewState } from '../bytes';
import { parseThemeColors, resolveColor } from './colors';
import { readDrawings } from './drawings';
import { fillFromSheet, parseRangeRef } from './charts';
import { createCalc, isMissing, needsCalc } from './formulas';
import { decodeText, parseDelimited, sniffDelimiter, csvToSheetModel } from './csv';
import { BuildCtx, MAX_ROWS, SheetModel, buildSheetModel, colName } from './model';
import { Grid, Sel } from './Grid';

interface Book { sheets: Array<{ name: string; tabColor?: string; model: () => SheetModel }> }

// 解析结果挂在字节上：字节由 bytes.ts 缓存，标签切回来时连解析也省掉；字节被淘汰后这里随之回收
const books = new WeakMap<ArrayBuffer, Promise<Book>>();

function toDataUrl(img: { buffer: ArrayBuffer | Uint8Array; extension: string }): string {
  const bytes = new Uint8Array(img.buffer as ArrayBuffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/${img.extension === 'jpg' ? 'jpeg' : img.extension};base64,${btoa(s)}`;
}

/** 工作表模型首次激活才构建（多表大文件不必一次建完） */
function lazy<T>(fn: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= fn());
}

async function parseXlsx(buf: ArrayBuffer): Promise<Book> {
  const { ExcelJS, numfmt } = await loadExcel();
  // 先过一遍 drawing：ExcelJS 解析不了的会被替换成空壳（否则整个文件加载时抛错），图表 / 图片锚点一并读出
  const { floats, patched } = await readDrawings(buf);
  const wb: any = new ExcelJS.Workbook();
  await wb.xlsx.load(patched || buf);
  const urls = new Map<string | number, string | undefined>();
  const date1904 = !!wb.properties?.date1904;
  // 有缺缓存值的公式（文件没被 Excel 算过）才加载公式引擎；加载失败不影响其余内容，只是这些格子留空
  const calc = needsCalc(wb) ? await loadFormula().then(({ Parser, formulajs }) => createCalc(wb, date1904, Parser, formulajs)).catch(() => undefined) : undefined;
  const ctx: BuildCtx = {
    numfmt, date1904, calc,
    // ExcelJS 把主题 XML 原文留在 _themes 里，主题色要自己解
    theme: parseThemeColors(wb._themes?.theme1),
    images: id => {
      if (!urls.has(id)) { const img = wb.getImage(id); urls.set(id, img?.buffer ? toDataUrl(img) : undefined); }
      return urls.get(id);
    },
  };
  // 图表：配色跟工作簿主题的强调色；没有缓存值的系列（openpyxl 不写缓存）按引用回表取数
  const palette = ctx.theme.slice(4, 10).map(c => `#${c}`);
  const lookup = (ref: string): unknown[] => {
    const g = parseRangeRef(ref);
    const ws = g && wb.getWorksheet(g.sheet);
    if (!g || !ws || (g.r2 - g.r1 + 1) * (g.c2 - g.c1 + 1) > 10000) return [];
    const out: unknown[] = [];
    for (let r = g.r1; r <= g.r2; r++) {
      for (let c = g.c1; c <= g.c2; c++) {
        const cell = ws.findCell(r + 1, c + 1);
        // ValueType.Formula 取计算结果；缺缓存值时现算，否则图表拿到的全是空
        const v = cell?.type === 6 ? (isMissing(cell.result) && calc ? calc(g.sheet, r + 1, c + 1) : cell.result) : cell?.value;
        out.push(v && typeof v === 'object' && !(v instanceof Date) ? v.error ?? (Array.isArray(v.richText) ? v.richText.map((x: any) => x.text).join('') : v.text) : v);
      }
    }
    return out;
  };
  // 取引用区域里第一个带数字格式的格子（首格可能是空的，如环比增长率的第一个月）
  const formatOf = (ref: string): string | undefined => {
    const g = parseRangeRef(ref);
    const ws = g && wb.getWorksheet(g.sheet);
    if (!g || !ws) return undefined;
    for (let r = g.r1; r <= g.r2 && r < g.r1 + 50; r++) {
      for (let c = g.c1; c <= g.c2 && c < g.c1 + 50; c++) { const f = ws.findCell(r + 1, c + 1)?.numFmt; if (f && f !== 'General') return f; }
    }
    return undefined;
  };
  for (const list of Object.values(floats)) {
    for (const f of list) if (f.chart) { f.chart.palette = palette; fillFromSheet(f.chart, lookup, formatOf); }
  }
  const visible = (wb.worksheets as any[]).filter(ws => !ws.state || ws.state === 'visible');
  return { sheets: visible.map(ws => ({ name: ws.name, tabColor: resolveColor(ws.properties?.tabColor, ctx.theme), model: lazy(() => buildSheetModel(ws, ctx, floats[ws.name])) })) };
}

function parseCsv(buf: ArrayBuffer, path: string): Book {
  const text = decodeText(buf);
  const rows = parseDelimited(text, /\.tsv$/i.test(path) ? '\t' : sniffDelimiter(text));
  const name = path.split(/[\\/]/).pop() || path;
  return { sheets: [{ name, model: lazy(() => csvToSheetModel(rows, name, rows.length >= MAX_ROWS)) }] };
}

/** 表格预览：顶部「单元格地址 + 公式栏」（只读）、中间网格、底部工作表标签；xlsx 与 csv / tsv 共用 */
export function SheetView({ buf, csv, path, tabId, scale, onError }: {
  buf: ArrayBuffer; csv: boolean; path: string; tabId: string; scale: number; onError: (msg: string) => void;
}) {
  const [book, setBook] = useState<Book | null>(null);
  const [idx, setIdx] = useState(0);
  // 每张表各自记住选区，切回来还原
  const [sels, setSels] = useState<Record<number, Sel>>({});

  useEffect(() => {
    let alive = true;
    setBook(null); setSels({});
    let p = books.get(buf);
    if (!p) {
      p = csv ? Promise.resolve().then(() => parseCsv(buf, path)) : parseXlsx(buf);
      books.set(buf, p);
      p.catch(() => books.delete(buf)); // 失败不缓存，重新打开时再试
    }
    p.then(b => {
      if (!alive) return;
      setBook(b);
      setIdx(Math.min(viewState.get(tabId)?.sheet || 0, Math.max(0, b.sheets.length - 1)));
    }).catch(e => { if (alive) onError(e?.message || String(e)); });
    return () => { alive = false; };
  }, [buf]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!book) return <div className="p-4 text-sm text-muted font-sans flex items-center gap-2"><Spinner />{t('office.loading')}</div>;
  if (!book.sheets.length) return <div className="p-4 text-sm text-muted font-sans">{t('office.noSheets')}</div>;

  const sheet = book.sheets[idx].model();
  const sel = sels[idx] || { r: 0, c: 0 };
  const cell = sheet.cells[sel.r]?.[sel.c];
  const pickSheet = (i: number) => { viewState.set(tabId, { ...viewState.get(tabId), sheet: i }); setIdx(i); };
  return (
    <div className="h-full flex flex-col font-sans bg-white">
      <div className="h-7 shrink-0 flex items-stretch border-b border-border text-xs">
        <div className="w-16 shrink-0 flex items-center justify-center border-r border-border text-fg">{colName(sel.c)}{sel.r + 1}</div>
        <div className="w-8 shrink-0 flex items-center justify-center border-r border-border text-muted italic font-serif">fx</div>
        <div className="flex-1 min-w-0 flex items-center px-2 truncate whitespace-pre text-fg" title={cell?.input}>{cell?.input}</div>
      </div>
      {sheet.capped && <div className="shrink-0 px-3 py-1 text-xs text-warn bg-warn/10 border-b border-border">{t('office.rowsCapped', { n: MAX_ROWS })}</div>}
      <div className="flex-1 min-h-0">
        <Grid key={idx} sheet={sheet} scale={scale} sel={sel} onSelect={s => setSels(m => ({ ...m, [idx]: s }))} />
      </div>
      {book.sheets.length > 1 && (
        <div className="h-8 shrink-0 flex items-center gap-1 px-2 border-t border-border overflow-x-auto scrollbar-none text-xs">
          {book.sheets.map((s, i) => (
            <button key={i} onClick={() => pickSheet(i)} className={cn('relative h-6 px-2.5 shrink-0 whitespace-nowrap rounded', i === idx ? 'bg-black/[0.07] text-fg' : 'text-muted hover:text-fg hover:bg-black/[0.05]')}>
              {s.name}
              {s.tabColor && <span className="absolute left-2 right-2 bottom-0 h-0.5 rounded" style={{ background: s.tabColor }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** csv / tsv：解码、解析，产出与 xlsx 同构的 SheetModel（共用网格） */
import { CellModel, SheetModel, MAX_ROWS, prefixSum } from './model';

/** 编码探测：BOM → 严格 UTF-8 → 回退 GB18030（国内 Excel 另存的 csv 多为 GBK） */
export function decodeText(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf, 0, Math.min(3, buf.byteLength));
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(buf);
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('gb18030').decode(buf); }
}

/** RFC 4180 状态机：引号内可含分隔符 / 换行，"" 转义为一个引号，兼容 CRLF 与 LF */
export function parseDelimited(text: string, delim: string, maxRows = MAX_ROWS): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length >= maxRows) return rows;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 分隔符嗅探：取前 20 行，在 , ; \t 里选「每行列数一致且最多」的那个 */
export function sniffDelimiter(text: string): string {
  const head = text.slice(0, 64 * 1024);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t']) {
    const rows = parseDelimited(head, d, 20);
    if (!rows.length) continue;
    const cols = rows[0].length;
    const same = rows.filter(r => r.length === cols).length / rows.length;
    const score = cols > 1 ? same * cols : 0;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

const NUM_RE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?%?$|^[-+]?\.\d+$/;
/** 显示宽度：CJK 等宽字符按 2 算 */
function textWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length && w < 60; i++) w += s.charCodeAt(i) > 0x2E7F ? 2 : 1;
  return w;
}

export function csvToSheetModel(rows: string[][], name: string, capped: boolean): SheetModel {
  let colCount = 26;
  for (const r of rows) if (r.length > colCount) colCount = r.length;
  const rowCount = Math.max(rows.length, 50);
  // 列宽：采样前 200 行按内容估，夹在 64–320px
  const colW: number[] = new Array(colCount).fill(64);
  for (const r of rows.slice(0, 200)) r.forEach((v, c) => { colW[c] = Math.max(colW[c], Math.min(320, textWidth(v) * 7 + 16)); });
  const cells: (CellModel | undefined)[][] = rows.map(r => r.map(v => (v === '' ? undefined : { text: v, input: v, s: 0, num: NUM_RE.test(v) || undefined })));
  return {
    name, rowCount, colCount, colX: prefixSum(colW), rowY: prefixSum(new Array(rowCount).fill(20)),
    cells, styles: [{}], merges: [], mergeAt: new Map(), anchors: [], gridLines: true, capped,
  };
}

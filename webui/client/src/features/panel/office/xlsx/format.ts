type Numfmt = typeof import('numfmt');

/** JS Date → Excel 序列号。ExcelJS 把日期单元格读成 UTC 的 Date，转回序列号再格式化，结果不受本机时区影响 */
export function dateToSerial(d: Date, date1904: boolean): number {
  return d.getTime() / 86400000 + 25569 - (date1904 ? 1462 : 0);
}

/** 按单元格数字格式输出显示文本；格式里的条件色（如 [Red]）一并返回，由调用方覆盖字体色 */
export function formatNumber(nf: Numfmt, fmt: string | undefined, v: number): { text: string; color?: string } {
  const pattern = fmt || 'General';
  try {
    const text = nf.format(pattern, v);
    const color = pattern.includes('[') ? nf.formatColor(pattern, v) : null;
    return { text, color: typeof color === 'string' && /^(#[0-9a-f]{3,8}|[a-z]+)$/i.test(color) ? color : undefined };
  } catch { return { text: String(v) }; }
}

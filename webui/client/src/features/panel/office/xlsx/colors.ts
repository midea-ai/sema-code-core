/** xlsx 颜色解析：argb / theme+tint / indexed 三种形态统一成 CSS 颜色 */

export interface XlsxColor { argb?: string; theme?: number; tint?: number; indexed?: number }

/** Office 默认主题色，按 Excel 的 theme 下标排列（0=lt1 1=dk1 2=lt2 3=dk2 4-9=accent1-6 10=hlink 11=folHlink） */
const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

/** 旧式调色板（indexed 0-63）；64 / 65 是系统前景 / 背景色 */
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696',
  '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
];

/**
 * 从主题 XML 取 12 个主题色。clrScheme 里的书写顺序是 dk1 lt1 dk2 lt2 …，
 * 而 Excel 的 theme 下标前两对是交换的（0=lt1 1=dk1 2=lt2 3=dk2），这里换回下标顺序。
 */
export function parseThemeColors(xml?: string): string[] {
  if (!xml) return DEFAULT_THEME;
  try {
    const scheme = new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('a:clrScheme')[0];
    if (!scheme) return DEFAULT_THEME;
    const raw = Array.from(scheme.children).map(el => {
      const c = el.firstElementChild;
      // srgbClr 直接给色值；sysClr（窗口文字 / 背景）取它缓存的 lastClr
      return (c?.localName === 'srgbClr' ? c.getAttribute('val') : c?.getAttribute('lastClr')) || '';
    });
    if (raw.length < 10) return DEFAULT_THEME;
    const order = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11];
    return order.map((i, k) => raw[i] || DEFAULT_THEME[k]);
  } catch { return DEFAULT_THEME; }
}

/** tint：负值压暗、正值提亮，按 Excel 的做法在 HLS 的亮度上算 */
function applyTint(hex: string, tint: number): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const rgb = s === 0 ? [l, l, l] : [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)];
  return rgb.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
}

export function resolveColor(c: XlsxColor | undefined, theme: string[]): string | undefined {
  if (!c) return undefined;
  // argb 的 alpha 不可信（openpyxl 常写 00RRGGBB 表示不透明），一律只取后 6 位
  if (c.argb) return `#${c.argb.slice(-6)}`;
  if (c.theme != null) {
    const base = theme[c.theme];
    return base ? `#${c.tint ? applyTint(base, c.tint) : base}` : undefined;
  }
  if (c.indexed != null) return c.indexed < 64 ? `#${INDEXED[c.indexed]}` : c.indexed === 64 ? '#000000' : undefined;
  return undefined;
}

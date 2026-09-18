/**
 * 使用情况页的数字与日期格式化。
 * token 用 K / M / B 口径（826 K、12.8 M），与聊天页的 k 口径不同，不复用。
 */

/** token 数：千以下原样，千级取整 K，百万及以上一位小数 */
export function formatUsageTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)} K`;
  if (n < 1_000_000_000) return `${trimZero((n / 1_000_000).toFixed(1))} M`;
  return `${trimZero((n / 1_000_000_000).toFixed(1))} B`;
}

/** 次数：万以下千分位，万及以上一位小数的 K / M */
export function formatCount(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${trimZero((n / 1000).toFixed(1))} K`;
  return `${trimZero((n / 1_000_000).toFixed(1))} M`;
}

/** 百分比：一位小数 */
export function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 本地日期 → YYYY-MM-DD */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD → 本地零点的 Date */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** YYYY-MM-DD → YYYY.MM.DD */
export function formatDateFull(key: string): string {
  return key.replace(/-/g, '.');
}

/** YYYY-MM-DD → MM.DD；跨年时带年份 */
export function formatDateShort(key: string, todayKey: string): string {
  return key.slice(0, 4) === todayKey.slice(0, 4) ? key.slice(5).replace('-', '.') : formatDateFull(key);
}

/** 时间戳 → 日期键 */
export function dateKeyOf(ts: number): string {
  return toDateKey(new Date(ts));
}

/** 星期简称，按界面语言的 locale */
export function formatWeekday(key: string, locale: string): string {
  return fromDateKey(key).toLocaleDateString(locale, { weekday: 'short' });
}

/** 月份简称，按界面语言的 locale */
export function formatMonth(d: Date, locale: string): string {
  return d.toLocaleDateString(locale, { month: 'short' });
}

/** 更新时间：当天只显示时分；跨天带月日；跨年带年份 */
export function formatUpdatedAt(ts: number, now: Date): string {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const key = toDateKey(d);
  const todayKey = toDateKey(now);
  if (key === todayKey) return hm;
  return `${formatDateShort(key, todayKey)} ${hm}`;
}

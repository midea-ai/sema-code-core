/**
 * 获取当前本地时间的标准格式字符串
 * 格式: YYYY-MM-DD
 * @returns 本地时间字符串
 */
export function getDayTimeString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/**
 * 获取当前时间的时分秒格式字符串
 * 格式: HH:MM:SS
 * @returns 时分秒字符串
 */
export function getTimeString(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
}

/**
 * 获取当前本地时间的标准格式字符串
 * 格式: YYYY-MM-DD HH:mm:ss
 * @returns 本地时间字符串
 */
export function getCurrentLocalTimeString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 获取当前时间戳（毫秒）
 * @returns 时间戳
 */
export function getCurrentTimestamp(): number {
  return Date.now();
}
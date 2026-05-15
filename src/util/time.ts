/**
 * 获取当前本地时间的标准格式字符串
 * 格式: YYYY-MM-DD
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
 * 获取当前时间的带方括号标签格式
 * 格式: [HH:MM:SS]
 */
export function getTimeTag(): string {
  return `[${getTimeString()}]`;
}

/**
 * 获取当前时间戳（毫秒）
 */
export function nowMillis(): number {
  return Date.now();
}
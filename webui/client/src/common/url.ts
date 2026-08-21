const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1']);

export function isLoopbackUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
  } catch { return false; }
}

/** 本机或局域网地址（开发服务器常用局域网 IP 访问），这类地址直接在右栏内嵌，不走探测 */
export function isPrivateUrl(u: string): boolean {
  if (isLoopbackUrl(u)) return true;
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const h = url.hostname;
    return /^10\.\d+\.\d+\.\d+$/.test(h) || /^192\.168\.\d+\.\d+$/.test(h) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h) || h.endsWith('.local') || h.endsWith('.internal');
  } catch { return false; }
}

/** file:// 地址 → 服务端本地文件代理路径（iframe 无法直接加载 file://，由 /api/local/<token> 只读代理） */
export function fileUrlToProxy(u: string, token: string): string {
  try { return `/api/local/${encodeURIComponent(token)}${new URL(u).pathname}`; } catch { return u; }
}

export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^file:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return `file://${encodeURI(s)}`; // 绝对路径视为本地文件
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/.test(s)) return `http://${s}`;
  return `http://${s}`;
}

/** 从任意文本中提取本地 URL（工具输出发现 dev server 用） */
export function extractLocalUrls(text: string): string[] {
  const out = new Set<string>();
  const re = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s"'<>)\]]*)?/g;
  for (const m of text.matchAll(re)) out.add(m[0].replace(/[.,;:]+$/, ''));
  return [...out];
}

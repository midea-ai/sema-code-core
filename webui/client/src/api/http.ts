/** REST 客户端：token 从 URL ?token= 读入并存 localStorage，之后请求走 Authorization 头 */
const TOKEN_KEY = 'sema.webui.token';

export function initToken() {
  const url = new URL(location.href);
  const t = url.searchParams.get('token');
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
    url.searchParams.delete('token');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T = any>(method: string, path: string, body?: any): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload: any = null;
  try { payload = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !payload?.ok) throw new ApiError(payload?.error || `${res.status} ${res.statusText}`, res.status);
  return payload.data as T;
}

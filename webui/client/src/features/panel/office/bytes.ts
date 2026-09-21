import { useEffect, useState } from 'react';
import { rawFileUrl } from '../../chat/fileRefs';

/** raw 字节上限：与 server/src/files/read.ts 的 MAX_RAW 保持一致 */
export const MAX_RAW = 50 * 1024 * 1024;

// 右栏只渲染激活标签，切走即卸载；字节按 路径+mtime+size 缓存，切回来不重新下载，文件被改写后 mtime 变化自然失效
const MAX_ITEMS = 3;
const MAX_BYTES = 120 * 1024 * 1024;
const cache = new Map<string, ArrayBuffer>(); // Map 保持插入顺序：队首最旧
const pending = new Map<string, Promise<ArrayBuffer>>();

function remember(key: string, buf: ArrayBuffer) {
  cache.delete(key);
  cache.set(key, buf);
  let total = 0;
  for (const b of cache.values()) total += b.byteLength;
  for (const [k, b] of cache) {
    if (cache.size <= MAX_ITEMS && total <= MAX_BYTES) break;
    if (k === key) break;
    cache.delete(k); total -= b.byteLength;
  }
}

async function fetchRaw(sessionId: string, path: string): Promise<ArrayBuffer> {
  const res = await fetch(rawFileUrl(sessionId, path));
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || res.statusText);
  return res.arrayBuffer();
}

/** 取文件原始字节（带缓存）：mtime / size 来自 FileTab 已有的 /file 响应 */
export function useFileBytes(sessionId: string, path: string, mtime: number, size: number): { buf: ArrayBuffer | null; error: string | null } {
  const key = `${sessionId}\n${path}\n${mtime}\n${size}`;
  const [state, setState] = useState<{ key: string; buf: ArrayBuffer | null; error: string | null }>({ key, buf: cache.get(key) || null, error: null });
  useEffect(() => {
    const hit = cache.get(key);
    if (hit) { remember(key, hit); setState({ key, buf: hit, error: null }); return; }
    let alive = true;
    setState({ key, buf: null, error: null });
    let p = pending.get(key);
    if (!p) {
      p = fetchRaw(sessionId, path).finally(() => pending.delete(key));
      pending.set(key, p);
    }
    p.then(buf => { remember(key, buf); if (alive) setState({ key, buf, error: null }); })
      .catch(e => { if (alive) setState({ key, buf: null, error: e.message }); });
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  // key 刚变、effect 还没跑时不把上一个文件的字节交出去
  return state.key === key ? state : { buf: null, error: null };
}

/** 每个标签的轻量视图状态（缩放、当前工作表 / 幻灯片 / pdf 页）：标签切走会卸载组件，切回来要还原；不进 store（panels 会整体写 localStorage） */
export const viewState = new Map<string, { zoom?: string; sheet?: number; slide?: number; page?: number }>();

/** 下载 / 另存为原始字节：有系统「另存为」对话框就先选位置再流式写入（取消不白下载），否则走 <a download> */
export async function downloadRaw(sessionId: string, path: string) {
  const name = path.split(/[\\/]/).pop() || path;
  const url = rawFileUrl(sessionId, path);
  if (typeof (window as any).showSaveFilePicker === 'function') {
    let handle: any;
    try { handle = await (window as any).showSaveFilePicker({ suggestedName: name }); }
    catch (e: any) { if (e?.name === 'AbortError') return; throw e; }
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error || res.statusText);
    await res.body.pipeTo(await handle.createWritable());
    return;
  }
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}

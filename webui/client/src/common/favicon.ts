/** 标签页 favicon 状态点：聚合所有存活会话状态，右下角叠色点（待应答 > 处理中 > 完成未读） */
import { useEffect, useMemo } from 'react';
import { useApp } from '../store/app';
import { useSessions } from '../store/sessions';
import { pendingBlocks } from '../../../shared/transcript';

export type FaviconDot = 'pending' | 'processing' | 'done' | null;

const DOT_VARS: Record<Exclude<FaviconDot, null>, [cssVar: string, fallback: string]> = {
  pending: ['--color-dot-pending', '#f97316'],
  processing: ['--color-dot-processing', '#5bbfe8'],
  done: ['--color-dot-done', '#34c759'],
};

let iconPromise: Promise<HTMLImageElement> | null = null;
const cache: Partial<Record<string, string>> = {};
let current: string | undefined;

function loadIcon(): Promise<HTMLImageElement> {
  if (!iconPromise) {
    iconPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = '/icon.svg';
    });
  }
  return iconPromise;
}

async function applyFaviconDot(dot: FaviconDot) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const key = dot ?? 'none';
  if (current === key) return;
  current = key;
  if (!dot) {
    link.type = 'image/svg+xml';
    link.href = '/icon.svg';
    return;
  }
  if (!cache[key]) {
    let img: HTMLImageElement;
    try { img = await loadIcon(); } catch { return; }
    // 等待期间状态又变了，放弃本次绘制
    if (current !== key) return;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, 64, 64);
    const [cssVar, fallback] = DOT_VARS[dot];
    const color = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || fallback;
    // 白描边让色点在图标上分离出来
    ctx.beginPath(); ctx.arc(49, 49, 15, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.beginPath(); ctx.arc(49, 49, 11, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    cache[key] = canvas.toDataURL('image/png');
  }
  if (current !== key) return;
  link.type = 'image/png';
  link.href = cache[key]!;
}

/** 全局状态点：任一存活会话有待应答（权限/提问/计划确认）＞ 处理中 ＞ 后台完成未读 ＞ 无 */
export function useStatusFavicon() {
  const snapshots = useSessions(s => s.snapshots);
  const status = useApp(s => s.status);
  const live = useApp(s => s.liveSessions);
  const doneUnread = useApp(s => s.doneUnread);

  const dot = useMemo<FaviconDot>(() => {
    let processing = false;
    for (const id of Object.keys(live)) {
      const snap = snapshots[id];
      if (snap) {
        if (pendingBlocks(snap).length > 0) return 'pending';
        if (snap.state === 'processing') processing = true;
      } else {
        // 未订阅的会话用服务端 bootstrap 快照统计
        const st = status[id];
        if (st && st.pending > 0) return 'pending';
        if (st?.state === 'processing') processing = true;
      }
    }
    if (processing) return 'processing';
    return Object.keys(doneUnread).length > 0 ? 'done' : null;
  }, [snapshots, status, live, doneUnread]);

  useEffect(() => { applyFaviconDot(dot); }, [dot]);
}

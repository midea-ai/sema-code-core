/** 「已完成未看」会话的两处联动：窗口重新可见时清掉当前会话的未看；桌面版把未看数同步到 Dock 角标 */
import { useEffect } from 'react';
import { useApp } from '../store/app';
import { desktop } from './desktop';

/** 窗口 / 标签页隐藏期间当前会话完成也会标为未看，重新可见时当前打开的会话视为已阅 */
export function useVisibilityRead() {
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      const app = useApp.getState();
      if (app.view.type === 'chat') app.clearDoneUnread(app.view.sessionId);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
}

/** 桌面版：已完成未看会话数 → Dock / 任务栏角标；网页模式无操作 */
export function useDockBadge() {
  const count = useApp(s => Object.keys(s.doneUnread).length);
  useEffect(() => { desktop?.setBadgeCount(count); }, [count]);
}

/** 桌面版：窗口隐藏期间被 Dock 唤起时，跳到最近完成未看的会话（有多条时点一次跳一条） */
export function useActivateJump() {
  useEffect(() => desktop?.onActivate(() => {
    const app = useApp.getState();
    const latest = Object.entries(app.doneUnread).sort((a, b) => b[1] - a[1])[0];
    if (latest) app.setView({ type: 'chat', sessionId: latest[0] });
  }), []);
}

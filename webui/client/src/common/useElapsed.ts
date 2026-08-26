import { useEffect, useState } from 'react';

/**
 * 运行中耗时计数：active 时每秒刷新；pausedAt（等待用户处理权限确认/快速确认/计划退出出现的时刻）
 * 非空时计时定格在该时刻。pausedMs 为该范围内已完成的用户等待总时长（由 waitedMsIn 从块数据推导，
 * 快照持久化了 resolvedTs，故刷新页面后依然准确），展示耗时时一并扣除。
 * 返回一个把某个原始结束时刻换算成「已扣除等待时长」耗时（毫秒）的函数。
 */
export function usePausableElapsed(start: number, active: boolean, pausedAt: number | undefined, pausedMs: number) {
  const [, tick] = useState(0);

  useEffect(() => {
    if (!active || pausedAt != null) return;
    const id = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(id);
  }, [active, pausedAt]);

  return (rawEnd: number) => (pausedAt != null ? pausedAt : rawEnd) - start - pausedMs;
}

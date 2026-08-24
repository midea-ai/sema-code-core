import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 运行中耗时计数：active 时每秒刷新；pausedAt（等待用户处理权限确认/快速确认/计划退出出现的时刻）
 * 非空时计时定格在该时刻，这段等待时长不计入之后（含结束后）的耗时展示——即恢复运行后从暂停前的
 * 已耗时继续累加，而不是把等待时长也算进去。resetKey 变化时清空累计暂停时长（同一组件切换到另一
 * 轮次/子代理时用）。返回一个把某个原始结束时刻换算成「已扣除暂停时长」耗时（毫秒）的函数。
 */
export function usePausableElapsed(start: number, active: boolean, pausedAt: number | undefined, resetKey?: unknown) {
  const [, tick] = useState(0);
  const pausedMsRef = useRef(0);
  const pauseStartRef = useRef<number | undefined>(undefined);
  const prevKeyRef = useRef(resetKey);
  if (prevKeyRef.current !== resetKey) {
    prevKeyRef.current = resetKey;
    pausedMsRef.current = 0;
    pauseStartRef.current = undefined;
  }

  useLayoutEffect(() => {
    if (pausedAt != null) {
      if (pauseStartRef.current == null) pauseStartRef.current = pausedAt;
    } else if (pauseStartRef.current != null) {
      pausedMsRef.current += Date.now() - pauseStartRef.current;
      pauseStartRef.current = undefined;
    }
  }, [pausedAt]);

  useEffect(() => {
    if (!active || pausedAt != null) return;
    const id = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(id);
  }, [active, pausedAt]);

  return (rawEnd: number) => (pausedAt != null ? pausedAt : rawEnd) - start - pausedMsRef.current;
}

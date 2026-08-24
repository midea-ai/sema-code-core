import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import type { AgentBlock, Block } from '../../../../shared/types';
import { pendingIn } from '../../../../shared/transcript';
import type { PanelTab } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { cn } from '../../common/ui';
import { usePausableElapsed } from '../../common/useElapsed';
import { renderBlockList, type BlockCtx } from '../chat/Blocks';
import { STATUS_TEXT, statusTone } from '../chat/AgentCard';

/** 从会话块列表中递归查找子代理块（子代理可能嵌套在其他 agent 块内） */
function findAgent(blocks: Block[], id: string): AgentBlock | undefined {
  for (const b of blocks) {
    if (b.kind === 'agent') {
      if (b.id === id) return b;
      const hit = findAgent(b.blocks, id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** 子代理内所有块（含嵌套）的最大时间戳，用于估算已结束子代理的耗时 */
function maxTs(blocks: Block[]): number {
  let m = 0;
  for (const b of blocks) {
    if (b.ts > m) m = b.ts;
    if (b.kind === 'agent') m = Math.max(m, maxTs(b.blocks));
  }
  return m;
}

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`;
};

/** 子代理详情标签页：状态徽标 + 标题 + 耗时；正文按主消息流同样方式渲染子代理的块，贴底时自动跟随 */
export function AgentTab({ sessionId, tab }: { sessionId: string; tab: PanelTab }) {
  const blocks = useSessions(s => s.snapshots[sessionId]?.blocks);
  const block = tab.blockId && blocks ? findAgent(blocks, tab.blockId) : undefined;

  const running = block?.status === 'running';
  const awaitingTs = useMemo(() => {
    if (!running || !block) return undefined;
    const pending = pendingIn(block.blocks);
    return pending.length ? Math.min(...pending.map(b => b.ts)) : undefined;
  }, [running, block]);
  // 运行中每秒刷新一次耗时；等待用户处理权限确认/快速确认/计划退出时计时定格，恢复后从暂停前的已耗时继续累加
  const elapsed = usePausableElapsed(block?.ts ?? 0, running, awaitingTs, tab.blockId);

  const ref = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const prevLen = useRef(0);
  const len = block?.blocks.length ?? 0;
  useEffect(() => {
    const el = ref.current;
    if (el && stick && len > prevLen.current) el.scrollTop = el.scrollHeight;
    prevLen.current = len;
  }, [len, stick]);
  // 切换到另一个子代理时回到顶部并恢复跟随
  useEffect(() => { setStick(true); prevLen.current = 0; if (ref.current) ref.current.scrollTop = 0; }, [tab.blockId]);
  const onScroll = () => { const el = ref.current; if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 10); };

  if (!block) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-sm text-muted gap-2 p-6 text-center">
        <Bot size={30} className="text-fg" />
        <div>未找到子代理记录</div>
      </div>
    );
  }

  const tone = statusTone(block.status);
  const title = `${block.agentType}(${block.title})`;
  const elapsedMs = block.status === 'running' ? elapsed(Date.now()) : Math.max(block.ts, maxTs(block.blocks)) - block.ts;
  const ctx: BlockCtx = { sessionId, noAutoOpenAgent: true };

  return (
    <>
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-border">
        <span className={cn('text-xs px-1.5 py-0.5 rounded shrink-0', tone === 'warn' && 'bg-warn/10 text-warn', tone === 'ok' && 'bg-ok/10 text-ok', tone === 'danger' && 'bg-danger/10 text-danger')}>{STATUS_TEXT[block.status]}</span>
        <span className="font-medium text-sm truncate flex-1" title={title}>{title}</span>
        <span className="text-xs text-muted shrink-0">耗时 {fmtDur(elapsedMs)}</span>
      </div>
      <div ref={ref} onScroll={onScroll} className="flex-1 min-h-0 overflow-auto px-4 py-3">
        {block.instructions && <div className="text-xs text-muted whitespace-pre-wrap mb-2 pb-2 border-b border-border/60">{block.instructions}</div>}
        {block.blocks.length === 0 ? <div className="text-sm text-muted text-center py-10">暂无消息记录</div> : renderBlockList(block.blocks, ctx)}
      </div>
    </>
  );
}

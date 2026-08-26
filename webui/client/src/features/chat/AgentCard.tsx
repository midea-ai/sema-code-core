import { useEffect } from 'react';
import type { AgentBlock } from '../../../../shared/types';
import { cn, Spinner } from '../../common/ui';
import { t } from '../../i18n';
import { useApp } from '../../store/app';
import type { BlockCtx } from './Blocks';

type Status = AgentBlock['status'];

export const STATUS_TEXT: Record<Status, string> = { running: '运行中...', completed: '已完成', failed: '失败', interrupted: '已中断' };
export const statusTone = (s: Status) => s === 'running' ? 'run' : s === 'completed' ? 'ok' : 'danger';

function StatusIcon({ status }: { status: Status }) {
  if (status === 'running') return <Spinner className="h-3 w-3 shrink-0" />;
  const tone = statusTone(status);
  return (
    <span className={cn('text-[11px] shrink-0', tone === 'ok' && 'text-ok', tone === 'danger' && 'text-danger')}>
      {status === 'completed' ? '✓' : '✗'}
    </span>
  );
}

/** 子代理卡片：左侧状态色条 + 状态图标 + `agentType(title)` + 「查看详情」（在右侧栏打开）；下方为结果摘要（逐行省略） */
export function AgentCard({ block, ctx }: { block: AgentBlock; ctx: BlockCtx }) {
  const openAgentTab = useApp(s => s.openAgentTab);
  // 子代理开始运行时自动在右侧栏打开详情（详情页内嵌套的卡片除外）
  useEffect(() => {
    if (block.status === 'running' && !ctx.noAutoOpenAgent) openAgentTab(ctx.sessionId, block.id);
  }, []);
  const tone = statusTone(block.status);
  const title = `${block.agentType}(${block.title})`;
  return (
    <div className={cn('my-1.5 rounded-lg border border-border bg-white text-sm border-l-2', tone === 'run' && 'border-l-accent bg-accent/[0.03]', tone === 'ok' && 'border-l-ok', tone === 'danger' && 'border-l-danger')}>
      <div className="flex items-center gap-2 px-3 py-1.5">
        <StatusIcon status={block.status} />
        <span className={cn('truncate flex-1', tone === 'run' && 'shimmer-text')} title={title}>{title}</span>
        <button type="button" onClick={() => openAgentTab(ctx.sessionId, block.id)} className="text-xs text-muted hover:text-fg shrink-0">{t('card.agentDetail')}</button>
      </div>
      {block.result && (
        <div className="px-3 pb-1.5 -mt-0.5">
          {block.result.split('\n').map((line, i) => <div key={i} className="text-xs text-dim leading-[1.4] truncate">{line}</div>)}
        </div>
      )}
    </div>
  );
}

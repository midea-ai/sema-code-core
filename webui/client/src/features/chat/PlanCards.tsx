import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { PlanExitBlock, NoticeBlock } from '../../../../shared/types';
import { useApp } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { Button, cn } from '../../common/ui';
import { t } from '../../i18n';
import { Markdown } from './Markdown';
import { Collapsible } from './DiffView';
import type { BlockCtx } from './Blocks';

/** 「Plan · 规划文档 · 文件名」标题行；文件名可点击在右侧栏打开 */
function PlanHeader({ filePath, ctx, right }: { filePath: string; ctx: BlockCtx; right?: React.ReactNode }) {
  const workingDir = useApp(s => s.registry.sessions.find(x => x.id === ctx.sessionId)?.workingDir || '');
  const openFileTab = useApp(s => s.openFileTab);
  const name = filePath.split(/[\\/]/).pop() || filePath;
  const rel = workingDir && (filePath.startsWith(workingDir + '/') || filePath.startsWith(workingDir + '\\')) ? filePath.slice(workingDir.length + 1) : filePath;
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-ok/10 text-ok shrink-0">Plan</span>
      <span className="shrink-0">规划文档</span>
      <span onClick={e => { e.stopPropagation(); if (filePath) openFileTab(ctx.sessionId, rel); }} className="font-mono text-[12.5px] text-accent truncate cursor-pointer hover:underline" title={filePath}>{name}</span>
      <span className="flex-1" />
      {right}
    </div>
  );
}

/** Plan 退出卡片：Ready to code + 状态徽标；规划文档（超长折叠）；选项按钮沿用原样式 */
export function PlanExitCard({ block, ctx }: { block: PlanExitBlock; ctx: BlockCtx }) {
  const respond = useSessions(s => s.respondPlanExit);
  const interrupt = useSessions(s => s.interrupt);
  const [open, setOpen] = useState(!block.resolved);
  const [busy, setBusy] = useState(false);
  const resolved = block.resolved;

  const pick = async (k: string) => {
    if (busy) return;
    setBusy(true);
    try { if (k === 'cancel') await interrupt(ctx.sessionId); else await respond(ctx.sessionId, block.id, block.agentId, k); } finally { setBusy(false); }
  };

  return (
    <div className={cn('my-2 rounded-lg border text-sm', resolved ? 'border-border bg-panel-2' : 'border-ok/50 bg-ok/5')}>
      <button type="button" onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        {open ? <ChevronDown size={14} className="text-muted shrink-0" /> : <ChevronRight size={14} className="text-muted shrink-0" />}
        <span className="font-medium">Ready to code</span>
        <span className="flex-1" />
        <span className={cn('text-[11px] px-2 h-5 inline-flex items-center rounded-full border shrink-0', resolved ? 'border-border text-muted' : 'border-ok/40 text-ok bg-ok/10')}>
          {resolved ? (resolved === '__interrupted' ? t('card.interrupted') : block.options[resolved] || resolved) : '待确认'}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <div className="rounded-md border border-border bg-bg">
            <div className="px-3 py-2 border-b border-border text-[13px]"><PlanHeader filePath={block.planFilePath} ctx={ctx} /></div>
            <Collapsible deps={block.planContent} className="px-3 py-2"><Markdown text={block.planContent} sessionId={ctx.sessionId} /></Collapsible>
          </div>
          {!resolved && (
            <div className="flex gap-2 mt-3 flex-wrap">
              {Object.entries(block.options).map(([k, label]) => (
                <Button key={k} size="sm" variant={k === 'clearContextAndStart' ? 'primary' : 'outline'} disabled={busy} onClick={() => pick(k)}>{label}</Button>
              ))}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => pick('cancel')} title="中断本轮，继续在 Plan 模式下补充需求">{t('card.keepPlanning')}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 开始实施计划的提示：Plan · 规划文档 · 文件名 + 可折叠的计划内容 */
export function PlanImplementCard({ block, ctx }: { block: NoticeBlock; ctx: BlockCtx }) {
  const [open, setOpen] = useState(true);
  // 文案形如「已清理上下文，开始实施计划：/path/plan.md」
  const filePath = block.text.split(/[:：]/).slice(1).join(':').trim();
  return (
    <div className="my-2 rounded-lg border border-border bg-white text-sm">
      <button type="button" onClick={() => setOpen(v => !v)} className="w-full px-3 py-2 text-left text-[13px]">
        <PlanHeader filePath={filePath} ctx={ctx} right={open ? <ChevronDown size={14} className="text-muted shrink-0" /> : <ChevronRight size={14} className="text-muted shrink-0" />} />
      </button>
      {open && block.detail && (
        <Collapsible deps={block.detail} className="px-3 pb-2 border-t border-border/60 pt-2"><Markdown text={block.detail} sessionId={ctx.sessionId} /></Collapsible>
      )}
    </div>
  );
}

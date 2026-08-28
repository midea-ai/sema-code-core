import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, Pencil, ArrowDown, ChevronDown, ChevronRight, Copy, Check, ThumbsUp, ThumbsDown, GitBranch } from 'lucide-react';
import type { Block } from '../../../../shared/types';
import { pendingBlocks, waitedMsIn } from '../../../../shared/transcript';
import { useApp } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { BlockRenderer, renderBlockList, htmlFilesOf, HtmlSiteCard, memoryFilesOf, MemoryCard, type BlockCtx } from './Blocks';
import { Composer } from './Composer';
import { Button, Modal, Spinner, useDialog, useCopy, cn } from '../../common/ui';
import { usePausableElapsed } from '../../common/useElapsed';
import { t } from '../../i18n';
import { fmtTime, shortPath } from '../../common/text';

export function ChatView({ sessionId }: { sessionId: string }) {
  const record = useApp(s => s.registry.sessions.find(x => x.id === sessionId));
  const registry = useApp(s => s.registry);
  const snap = useSessions(s => s.snapshots[sessionId]);
  const loading = useSessions(s => s.loading[sessionId]);
  const open = useSessions(s => s.open);
  const toast = useApp(s => s.toast);
  const sidebarCollapsed = useApp(s => s.sidebarCollapsed);
  const dialog = useDialog();
  const listRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [rewind, setRewind] = useState<{ inputId: string; preview?: any; restore: boolean; busy: boolean } | null>(null);
  const [branching, setBranching] = useState(false);

  useEffect(() => { open(sessionId).catch(e => toast(e.message, 'error')); }, [sessionId, open, toast]);

  // 停留续租：正在看的会话每 4 分钟补发 warm 保活（服务端 warm 宽限 5 分钟）；
  // 后台标签页跳过续租，切回前台立即补一次；离开会话后由服务端按宽限期回收
  useEffect(() => {
    const rewarm = () => { if (!document.hidden) useSessions.getState().warm(sessionId); };
    const timer = setInterval(rewarm, 4 * 60_000);
    document.addEventListener('visibilitychange', rewarm);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', rewarm); };
  }, [sessionId]);

  // 自动滚动：贴底时跟随
  const blocks = snap?.blocks;
  useEffect(() => {
    if (stick && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [blocks, stick]);
  const onScroll = () => {
    const el = listRef.current; if (!el) return;
    setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };
  const scrollToBottom = () => {
    const el = listRef.current; if (!el) return;
    el.scrollTop = el.scrollHeight;
    setStick(true);
  };

  const onRewind = useCallback(async (inputId: string) => {
    setRewind({ inputId, restore: true, busy: false });
    try {
      const preview = await useSessions.getState().getForkPreview(sessionId, inputId);
      setRewind(r => r && r.inputId === inputId ? { ...r, preview, restore: !!preview?.canRestoreFiles && preview.files?.length > 0 } : r);
    } catch (e: any) { toast(e.message, 'error'); }
  }, [sessionId, toast]);

  const doRewind = async () => {
    if (!rewind) return;
    setRewind({ ...rewind, busy: true });
    // 截断前先取出被回退的那条用户消息文字，回退成功后放回输入框供修改重发
    const src = useSessions.getState().snapshots[sessionId]?.blocks
      .find(b => b.kind === 'user' && b.inputId === rewind.inputId);
    const srcText = src?.kind === 'user' ? src.text : '';
    try {
      const r = await useSessions.getState().fork(sessionId, rewind.inputId, rewind.restore && !!rewind.preview?.canRestoreFiles);
      if (r && r.ok === false) throw new Error(r.error);
      setRewind(null);
      if (srcText) useSessions.getState().setDraft(sessionId, d => ({ ...d, text: srcText }));
      await useSessions.getState().loadSnapshot(sessionId);
    } catch (e: any) { toast(e.message, 'error'); setRewind(r => r ? { ...r, busy: false } : r); }
  };

  const ctx = useMemo(() => ({ sessionId, onRewind }), [sessionId, onRewind]);
  const turns = useMemo(() => groupTurns(snap?.blocks || []), [snap?.blocks]);
  // 正在运行的一轮：最后一个非排队的轮次开头（用户消息，或计划实施后的合成开头）所在组
  const runningIdx = useMemo(() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      const o = turns[i].opener;
      if (o && !(o.kind === 'user' && o.queued)) return i;
    }
    return -1;
  }, [turns]);
  // 未决交互（权限确认/快速确认/计划退出）出现的最早时间：运行中该轮的「正在思考」提示与耗时计时应在此刻暂停
  const awaitingTs = useMemo(() => {
    if (!snap) return undefined;
    const pending = pendingBlocks(snap);
    return pending.length ? Math.min(...pending.map(b => b.ts)) : undefined;
  }, [snap]);

  const branchToNewChat = useCallback(async (beforeMessageUuid?: string) => {
    if (branching) return;
    setBranching(true);
    try {
      const next = await useSessions.getState().branchToNewChat(sessionId, beforeMessageUuid);
      setBranching(false);
      useApp.getState().setView({ type: 'chat', sessionId: next.id });
    } catch (e: any) {
      setBranching(false);
      toast(e.message || '分支失败', 'error');
    }
  }, [branching, sessionId, toast]);

  const canBranchNow = !!snap
    && snap.state === 'idle'
    && awaitingTs == null
    && !snap.streamingId
    && !snap.blocks.some(b => b.kind === 'user' && b.queued);

  const renameTitle = async () => {
    const title = await dialog.prompt({ title: t('menu.rename'), defaultValue: record?.title || '' });
    if (title !== null) useApp.getState().renameSession(sessionId, title).catch(e => toast(e.message, 'error'));
  };

  if (!record) return <div className="flex-1 flex items-center justify-center text-muted">会话不存在</div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 头部 */}
      <div className={cn('h-11 shrink-0 flex items-center gap-2 px-4 border-b border-border', sidebarCollapsed && 'pl-12')}>
        <button onClick={renameTitle} className="group inline-flex items-center gap-2 min-w-0 max-w-[60%]" title={record.workingDir}>
          <span className="truncate font-medium">{record.title || t('chat.untitled')}</span>
          <Pencil size={12} className="text-muted opacity-0 group-hover:opacity-100 shrink-0" />
        </button>
        <span className="text-xs text-muted truncate hidden md:inline" title={record.workingDir}>{shortPath(record.workingDir)}</span>
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => useApp.getState().revealSession(sessionId).catch(e => toast(e.message, 'error'))}><FolderOpen size={13} />{t('chat.openLocation')}</Button>
      </div>

      {/* 消息流 */}
      <div className="relative flex-1 min-h-0">
      <div ref={listRef} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-4">
          {!snap && loading && <div className="flex items-center gap-2 text-muted text-sm"><Spinner />{t('common.loading')}</div>}
          {snap && snap.blocks.length === 0 && (snap.agentMode === 'Design' ? (
            // Design 空会话：对齐默认新会话页（DraftView）的居中大字样式，与普通会话的小字提示区分
            <div className="min-h-[60vh] flex flex-col items-center justify-center text-center gap-3">
              <div className="text-2xl font-semibold inline-flex items-center gap-2">
                {t('chat.emptyTitleDesign')}
                <span className="text-[11px] leading-none px-1.5 py-1 rounded bg-design/10 text-design font-medium">Design</span>
              </div>
              <div className="text-muted max-w-md">{t('chat.emptyHintDesign')}</div>
            </div>
          ) : (
            <div className="text-center text-muted text-sm mt-24">
              <div className="text-lg text-fg mb-1">{t('chat.emptyTitle')}</div>
              <div>{t('chat.emptyHint')}</div>
            </div>
          ))}
          {turns.map((turn, i) => {
            // 分支锚点：中间轮次取下一轮用户输入的 inputId（历史截到它之前）；
            // 下一轮开头是合成块（plan-implement）或无 inputId 时截不出干净边界，不提供分支。
            // 最后一轮不带锚点 = 全量分支。
            const last = i === turns.length - 1;
            const nextOpener = last ? undefined : turns[i + 1]?.opener;
            const anchor = nextOpener?.kind === 'user' ? nextOpener.inputId : undefined;
            return (
              <TurnGroup key={turn.blocks[0].id} turn={turn} ctx={ctx}
                active={snap!.state === 'processing' && i === runningIdx}
                awaitingTs={i === runningIdx ? awaitingTs : undefined}
                canBranch={canBranchNow && (last || !!anchor)}
                branchAnchor={anchor}
                branching={branching}
                onBranch={branchToNewChat} />
            );
          })}
        </div>
      </div>
      {/* 回到底部：离底时悬浮显示；运行中图标换成三点动画表示进行中 */}
      {!stick && (
        <button onClick={scrollToBottom} title={t('chat.scrollBottom')}
          className="absolute left-1/2 -translate-x-1/2 bottom-3 h-8 w-8 rounded-full bg-bg border border-border shadow-lg flex items-center justify-center text-muted hover:text-fg">
          {snap?.state === 'processing' ? <span className="run-dots"><i /><i /><i /></span> : <ArrowDown size={15} />}
        </button>
      )}
      </div>

      {/* 输入区 */}
      <Composer sessionId={sessionId} />

      {/* 回退对话框 */}
      <Modal open={!!rewind} onClose={() => !rewind?.busy && setRewind(null)} title={t('chat.rewindTitle')}>
        <p className="text-sm text-muted mb-3">{t('chat.rewindDesc')}</p>
        {!rewind?.preview ? <div className="text-sm text-muted flex items-center gap-2"><Spinner />{t('common.loading')}</div> : (
          rewind.preview.files?.length ? (
            <div>
              <label className={cn('inline-flex items-center gap-2 text-sm', !rewind.preview.canRestoreFiles && 'opacity-50')}>
                <input type="checkbox" disabled={!rewind.preview.canRestoreFiles} checked={rewind.restore} onChange={e => setRewind({ ...rewind, restore: e.target.checked })} />
                {t('chat.restoreFiles')}
              </label>
              <ul className="mt-2 max-h-48 overflow-auto text-xs font-mono flex flex-col gap-0.5">
                {rewind.preview.files.map((f: any) => (
                  <li key={f.filePath} className="flex gap-2"><span className="text-muted w-14 shrink-0">{f.effect}</span><span className="truncate flex-1">{f.displayPath}</span><span><span className="text-ok">+{f.additions}</span> <span className="text-danger">-{f.removals}</span></span></li>
                ))}
              </ul>
            </div>
          ) : <div className="text-sm text-muted">{t('chat.rewindNoFiles')}</div>
        )}
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="ghost" disabled={rewind?.busy} onClick={() => setRewind(null)}>{t('dialog.cancel')}</Button>
          <Button variant="danger" disabled={!rewind?.preview || rewind.busy} onClick={doRewind}>{rewind?.busy ? <Spinner /> : null}{t('chat.rewind')}</Button>
        </div>
      </Modal>
    </div>
  );
}

function fmtDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分钟 ${s % 60}秒`;
  return `${Math.floor(m / 60)}小时 ${m % 60}分钟`;
}

/** 轮次开头：用户消息，或「清理上下文并开始实施计划」后的合成 plan-implement 提示块 */
type TurnOpener = Extract<Block, { kind: 'user' }> | Extract<Block, { kind: 'notice' }>;
function isTurnOpener(b: Block): b is TurnOpener {
  return b.kind === 'user' || (b.kind === 'notice' && b.noticeType === 'plan-implement');
}

/** 一轮对话：以轮次开头块为界切分（会话开头无开头块的前置块单独成组） */
interface Turn { blocks: Block[]; opener?: TurnOpener }

function groupTurns(blocks: Block[]): Turn[] {
  const turns: Turn[] = [];
  // 排队中的输入不切轮：悬挂到列表末尾，运行轮的后续输出仍归运行轮；
  // 真正开始处理时 reducer 会把该块搬到 blocks 末尾并翻掉 queued，自然成为新轮开头
  const queuedTail: Turn[] = [];
  let cur: Turn | null = null;
  for (const b of blocks) {
    if (b.kind === 'branch-origin') {
      cur = null;
      turns.push({ blocks: [b] });
      cur = null;
      continue;
    }
    if (b.kind === 'user' && b.queued && !b.doneTs) { queuedTail.push({ blocks: [b], opener: b }); continue; }
    if (isTurnOpener(b)) { cur = { blocks: [b], opener: b }; turns.push(cur); continue; }
    if (!cur) { cur = { blocks: [] }; turns.push(cur); }
    cur.blocks.push(b);
  }
  return queuedTail.length ? [...turns, ...queuedTail] : turns;
}

const isWork = (b: Block) => b.kind === 'tool' || b.kind === 'agent';
/** 末尾卡片：待办面板与定时任务卡片，恒排在本轮所有块之后 */
const isTail = (b: Block) => b.kind === 'todos' || b.kind === 'cron';
const isText = (b: Block) => b.kind === 'assistant' && !!b.text;

/**
 * 一轮的渲染。
 * 运行中：用户气泡 →（有文字/工具后）「已处理 N秒」分隔 → 全部块按原顺序（连续 ≥2 工具收成 live 组，组头为最后一个工具的摘要）
 * →（仅当最后一个可见块是已完成的文字或本轮尚无输出时）「正在思考」状态行。
 * 结束后：「耗时 N秒 ›」分隔 → 文件改动卡片 + 最终结论（最后一段文字）+ 其后的非工具块 + 待办/定时任务卡片 → 复制行；中间过程默认折叠。
 * 展开时按原顺序显示全部块（组头为类别文案），与运行中渲染仅差组名与状态行。
 */
function TurnGroup({ turn, ctx, active, awaitingTs, canBranch, branchAnchor, branching, onBranch }: {
  turn: Turn; ctx: BlockCtx; active: boolean; awaitingTs?: number;
  canBranch?: boolean; branchAnchor?: string; branching?: boolean; onBranch?: (beforeMessageUuid?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const opener = turn.opener;
  const rest = opener ? turn.blocks.slice(1) : turn.blocks;
  const running = active && !!opener && !opener.doneTs;

  if (!opener) return <>{renderBlockList(rest, ctx)}</>;
  const queued = opener.kind === 'user' && !!opener.queued;

  let lastTextIdx = -1;
  for (let i = rest.length - 1; i >= 0; i--) if (isText(rest[i])) { lastTextIdx = i; break; }
  const lastText = lastTextIdx >= 0 ? rest[lastTextIdx] as Extract<Block, { kind: 'assistant' }> : null;
  const before = lastTextIdx >= 0 ? rest.slice(0, lastTextIdx) : [];
  const after = lastTextIdx >= 0 ? rest.slice(lastTextIdx + 1) : rest;

  // 待办面板 / 定时任务卡片与文件改动卡片一样始终排在本轮末尾（运行中/展开/折叠三种视图一致），不按工具调用发生的位置插在过程里
  const tailCards = rest.filter(isTail);
  const ordered = [...rest.filter(b => !isTail(b)), ...tailCards];
  // 折叠视图：文件改动卡片 + 最后一段文字 + 其后的非工具块 + 待办/定时任务卡片
  const collapsedView: Block[] = [
    ...before.filter(b => b.kind === 'file-changes'),
    ...(lastText ? [lastText] : []),
    ...after.filter(b => !isWork(b) && !isTail(b)),
    ...tailCards,
  ];
  const hidden = rest.filter(b => !collapsedView.includes(b));
  // 运行中不折叠过程（工具全部可见），结束后才收成摘要视图
  const collapsible = !running && hidden.length > 0;
  const hasWork = rest.some(isWork);
  const started = !!lastText || hasWork;

  // 状态行：仅「正在思考」——最后一个可见块是已完成的文字、或本轮尚无输出时显示；
  // 最后是工具/工具组/子代理时由其行内 spinner 表达状态；文字流式输出中不显示；
  // 等待用户处理权限确认/快速确认/计划退出时不算「思考」，不显示该提示
  let showThinking = false;
  if (running && awaitingTs == null) {
    const lastVisible = [...rest].reverse().find(b => isWork(b) || isText(b));
    showThinking = !lastVisible || (lastVisible.kind === 'assistant' && lastVisible.done);
  }

  return (
    <div>
      <BlockRenderer block={opener} ctx={ctx} />
      {!queued && (running ? started : (hasWork || collapsible)) && (
        <TurnDivider start={opener.ts} end={opener.doneTs ?? (running ? undefined : (rest[rest.length - 1]?.ts ?? opener.ts))} active={running} pausedAt={running ? awaitingTs : undefined} pausedMs={waitedMsIn(rest)} collapsible={collapsible} expanded={expanded} onToggle={() => setExpanded(v => !v)} />
      )}
      {running ? renderBlockList(ordered, ctx, true) : (expanded && collapsible) ? renderBlockList(ordered, ctx) : renderBlockList(collapsedView, ctx)}
      {/* 本轮新建/修改的 html 文件：结论之后给「网站卡片」，默认右栏浏览器预览（本轮结束后显示，避免半成品页面） */}
      {!running && htmlFilesOf(rest).map(p => <HtmlSiteCard key={`site:${p}`} sessionId={ctx.sessionId} path={p} />)}
      {/* 本轮新建/修改的 .sema/memory/ 记忆文件：结论之后给「记忆卡片」，点击右栏打开记忆窗口 */}
      {!running && memoryFilesOf(rest).length > 0 && <MemoryCard sessionId={ctx.sessionId} files={memoryFilesOf(rest)} />}
      {showThinking && <StatusLine text={t('chat.thinking')} />}
      {!running && lastText && <FinalActions text={lastText.text} ts={lastText.ts}
        onBranch={canBranch && onBranch ? () => onBranch(branchAnchor) : undefined}
        branchTitle={branchAnchor ? t('chat.branchHere') : undefined}
        branching={branching} />}
    </div>
  );
}

function StatusLine({ text }: { text: string }) {
  return (
    <div className="my-3 inline-flex items-center gap-1.5 text-[13px]">
      <span className="shimmer-text">{text}</span>
    </div>
  );
}

/** 文字回答下方的操作行：复制 · 赞 · 踩，悬浮显示时间（chat 主流与快问面板共用） */
export function FinalActions({ text, ts, className, onBranch, branchTitle, branching }: {
  text: string; ts?: number; className?: string; onBranch?: () => void; branchTitle?: string; branching?: boolean;
}) {
  const { copied, copy } = useCopy();
  // 点赞/踩：仅前端本地状态，无后端处理
  const [vote, setVote] = useState<'up' | 'down' | null>(null);
  const time = ts ? fmtTime(ts) : '';
  const btn = 'p-1 rounded hover:bg-black/[0.05] hover:text-fg';
  return (
    <div className={cn('group flex items-center gap-1 text-xs text-dim', className ?? '-mt-1 mb-2')}>
      <button onClick={() => copy(text)} className={btn} title={t('chat.copy')}>
        {copied ? <Check size={13} className="text-ok" /> : <Copy size={13} />}
      </button>
      <button onClick={() => setVote(v => v === 'up' ? null : 'up')} className={cn(btn, vote === 'up' && 'text-fg')} title={t('chat.good')}>
        <ThumbsUp size={13} fill={vote === 'up' ? 'currentColor' : 'none'} />
      </button>
      <button onClick={() => setVote(v => v === 'down' ? null : 'down')} className={cn(btn, vote === 'down' && 'text-fg')} title={t('chat.bad')}>
        <ThumbsDown size={13} fill={vote === 'down' ? 'currentColor' : 'none'} />
      </button>
      {onBranch && (
        <button onClick={onBranch} disabled={branching} className={cn(btn, branching && 'opacity-50 cursor-not-allowed')} title={branchTitle ?? t('chat.branch')}>
          <GitBranch size={13} />
        </button>
      )}
      {time && <span className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity">{time}</span>}
    </div>
  );
}

function TurnDivider({ start, end, active, pausedAt, pausedMs, collapsible, expanded, onToggle }: { start: number; end?: number; active: boolean; pausedAt?: number; pausedMs: number; collapsible: boolean; expanded: boolean; onToggle: () => void }) {
  // 等待用户处理权限确认/快速确认/计划退出时，计时定格在请求出现的时刻；pausedMs（本轮已完成等待的总时长，
  // 从块数据推导、随快照持久化）在展示时扣除——即恢复后从暂停前的已耗时继续累加，刷新页面后依然准确
  const elapsed = usePausableElapsed(start, active, pausedAt, pausedMs);
  return (
    <div className="my-3 text-[13px] text-dim">
      <button onClick={collapsible ? onToggle : undefined} className={cn('inline-flex items-center gap-1.5', collapsible ? 'hover:text-fg cursor-pointer' : 'cursor-default')} title={collapsible ? t('chat.toggleProcess') : undefined}>
        <span>{active ? t('chat.processed') : t('chat.elapsed')} {fmtDuration(elapsed(end ?? Date.now()))}</span>
        {collapsible && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      </button>
      <div className="border-t border-border mt-1.5" />
    </div>
  );
}


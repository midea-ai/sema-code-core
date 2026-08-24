import { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestion, Send } from 'lucide-react';
import { useSessions } from '../../store/sessions';
import { useApp } from '../../store/app';
import { Markdown } from '../chat/Markdown';
import { Spinner } from '../../common/ui';
import { t } from '../../i18n';

/** 面板内发出、尚未收到回答的问题（core 无 start 事件，等待态只能由本地发送方维护） */
interface PendingQ { id: number; question: string }
let pendingSeq = 0;

/** 「快问」标签：展示 /quickchat 旁路问答记录，底部可直接提问（自动加 /quickchat 前缀），独立于主对话消息流 */
export function QuickchatTab({ sessionId }: { sessionId: string }) {
  const quickchats = useSessions(s => s.snapshots[sessionId]?.quickchats) || [];
  const sendQuickchat = useSessions(s => s.sendQuickchat);
  const hasModel = useApp(s => !!s.modelData?.modelList?.length);
  const toast = useApp(s => s.toast);
  const setView = useApp(s => s.setView);
  const [pending, setPending] = useState<PendingQ[]>([]);
  const [text, setText] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const lenRef = useRef(quickchats.length);

  // 回答到达（含从主输入框发的）：按 FIFO 消掉等待项
  useEffect(() => {
    const added = quickchats.length - lenRef.current;
    lenRef.current = quickchats.length;
    if (added > 0) setPending(p => p.slice(added));
  }, [quickchats.length]);

  // 新回答 / 新等待项滚到底部
  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight }); }, [quickchats.length, pending.length]);

  const send = async () => {
    const q = text.trim();
    if (!q) return;
    if (!hasModel) { toast(t('chat.noModel'), 'warn'); setView({ type: 'settings', tab: 'models' }); return; }
    setText('');
    const item = { id: ++pendingSeq, question: q };
    setPending(p => [...p, item]);
    // 主会话中断会连带中止 quickchat 且没有任何事件，等待项超时自动消失兜底
    window.setTimeout(() => setPending(p => p.filter(x => x.id !== item.id)), 120_000);
    try { await sendQuickchat(sessionId, q); }
    catch (e: any) { toast(e?.message || String(e), 'error'); setPending(p => p.filter(x => x.id !== item.id)); }
  };

  return (
    <>
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        {!quickchats.length && !pending.length && (
          <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted gap-2">
            <MessageCircleQuestion size={30} className="text-fg" />
            <div className="text-base font-medium text-fg">{t('panel.quickchat')}</div>
            <div className="max-w-xs text-xs">{t('quickchat.emptyHint')}</div>
          </div>
        )}
        {quickchats.map(q => (
          <div key={q.seq} className="rounded-lg border border-border">
            <div className="px-3 py-2 border-b border-border/60 text-xs font-medium flex items-start gap-1.5">
              <MessageCircleQuestion size={14} className="shrink-0 mt-px text-muted" />
              <span className="whitespace-pre-wrap break-words">{q.question}</span>
            </div>
            <div className="px-3 py-2 text-sm">
              <Markdown text={q.content} sessionId={sessionId} />
            </div>
          </div>
        ))}
        {pending.map(p => (
          <div key={p.id} className="rounded-lg border border-border">
            <div className="px-3 py-2 border-b border-border/60 text-xs font-medium flex items-start gap-1.5">
              <MessageCircleQuestion size={14} className="shrink-0 mt-px text-muted" />
              <span className="whitespace-pre-wrap break-words">{p.question}</span>
            </div>
            <div className="px-3 py-2 text-xs text-muted flex items-center gap-2"><Spinner />{t('quickchat.waiting')}</div>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-border p-2 flex items-center gap-1.5">
        <input value={text} onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send(); }}
          placeholder={t('quickchat.inputPlaceholder')}
          className="flex-1 h-8 px-2.5 rounded-md bg-panel border border-transparent text-xs outline-none focus:border-accent focus:bg-white" />
        <button onClick={() => void send()} disabled={!text.trim()}
          className="h-8 w-8 flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-black/[0.05] disabled:opacity-30" title={t('quickchat.send')}>
          <Send size={14} />
        </button>
      </div>
    </>
  );
}

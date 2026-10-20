import { useEffect, useState } from 'react';
import { Target } from 'lucide-react';
import { useApp } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { Button, Spinner } from '../../common/ui';
import { t, useLang } from '../../i18n';

/** 「x 分钟前更新 / x 小时 y 分钟前更新」：只算时分不算天 */
function fmtUpdatedAgo(ts: number): string {
  const d = Math.max(0, Date.now() - ts);
  if (d < 60_000) return t('goal.updatedJustNow');
  const m = Math.floor(d / 60_000);
  if (m < 60) return t('goal.updatedMinutesAgo', { m });
  return t('goal.updatedHoursAgo', { h: Math.floor(m / 60), m: m % 60 });
}

/** 「目标」标签：顶栏左侧上次更新时间、右侧保存；下方编辑目标文字，与快照不同时保存可点，保存调 updateGoal（立即生效，下一轮按新目标推进） */
export function GoalTab({ sessionId }: { sessionId: string }) {
  useLang();
  const goal = useSessions(s => s.snapshots[sessionId]?.goal) ?? null;
  const updateGoal = useSessions(s => s.updateGoal);
  const toast = useApp(s => s.toast);
  const [text, setText] = useState(goal?.text ?? '');
  const [saving, setSaving] = useState(false);
  const [, tick] = useState(0);

  // 快照里的目标文字变化（别处更新 / 新设目标 / 清除）时同步编辑区
  useEffect(() => { setText(goal?.text ?? ''); }, [goal?.text]);
  // 相对时间每分钟刷新
  useEffect(() => { const id = window.setInterval(() => tick(n => n + 1), 60_000); return () => window.clearInterval(id); }, []);

  if (!goal) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-muted gap-2 p-6">
        <Target size={30} className="text-fg" />
        <div className="text-base font-medium text-fg">{t('panel.goal')}</div>
        <div className="max-w-xs text-xs">{t('goal.empty')}</div>
      </div>
    );
  }

  const trimmed = text.trim();
  const dirty = trimmed !== '' && trimmed !== goal.text;
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try { await updateGoal(sessionId, trimmed); }
    catch (e: any) { toast(e?.message || String(e), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <>
      <div className="h-10 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-border">
        <span className="text-xs text-muted truncate">{fmtUpdatedAgo(goal.updatedAt)}</span>
        <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={save} className="disabled:bg-black/[0.08] disabled:text-muted/60">
          {saving && <Spinner />}{t('goal.save')}
        </Button>
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} spellCheck={false}
        className="flex-1 min-h-0 w-full resize-none bg-transparent p-3 text-sm leading-chat outline-none" />
    </>
  );
}

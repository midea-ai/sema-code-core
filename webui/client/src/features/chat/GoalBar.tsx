import { Target, CirclePause, CirclePlay, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import type { GoalState } from '../../../../shared/types';
import { useApp } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { t, useLang, type I18nKey } from '../../i18n';

/**
 * 长期目标状态条：挂在输入框正上方，样式沿用草稿页项目条（上圆角、底部负边距压到输入框后面、比输入框略窄）。
 * 单行：图标 + 状态文字 + 目标文字（窄时截断，title 全文）+ 操作按钮；点击文字区在右栏打开「目标」标签编辑。
 * 操作不走输入队列：直接调会话级接口，立即生效。中止只结束循环，不打断当前轮（要立刻停用输入框的停止键）。
 */
export function GoalBar({ sessionId, goal }: { sessionId: string; goal: GoalState }) {
  useLang();
  const goalAction = useSessions(s => s.goalAction);
  const openGoalTab = useApp(s => s.openGoalTab);
  const toast = useApp(s => s.toast);
  const run = (action: 'stop' | 'clear' | 'resume') => goalAction(sessionId, action).catch(e => toast(e?.message || String(e), 'error'));
  const resumable = goal.status === 'paused' || goal.status === 'blocked';

  return (
    <div className="mx-3 rounded-t-xl bg-black/[0.035] px-3 pt-1.5 pb-4 -mb-3 flex items-center gap-1 text-xs">
      <button onClick={() => openGoalTab(sessionId)} title={goal.text}
        className="flex-1 min-w-0 h-6 flex items-center gap-1.5 text-left rounded hover:bg-black/[0.04] px-1 -ml-1">
        {/* 图标与状态文字统一用 accent 蓝，不随状态变色；状态只靠文字区分 */}
        <Target size={13} className="shrink-0 text-accent" />
        <span className="shrink-0 font-medium text-accent">{t(`goal.status.${goal.status}` as I18nKey)}</span>
        <span className="truncate text-muted">{goal.text}</span>
      </button>
      {/* 中止 / 恢复用同一对线性圆圈图标，按状态只显示其一；编辑用跳转图标（在右栏打开）；清除用删除图标，避免误以为只是关闭状态条 */}
      {goal.status === 'running' && <IconBtn title={t('goal.stop')} onClick={() => run('stop')}><CirclePause size={14} /></IconBtn>}
      {resumable && <IconBtn title={t('goal.resume')} onClick={() => run('resume')}><CirclePlay size={14} /></IconBtn>}
      <IconBtn title={t('goal.update')} onClick={() => openGoalTab(sessionId)}><SquareArrowOutUpRight size={13} /></IconBtn>
      <IconBtn title={t('goal.clear')} onClick={() => run('clear')}><Trash2 size={13} /></IconBtn>
    </div>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title}
      className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-muted hover:text-fg hover:bg-black/[0.06]">
      {children}
    </button>
  );
}

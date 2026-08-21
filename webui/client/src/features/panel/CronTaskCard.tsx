import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import type { CronTask } from '../../../../shared/types';
import { cn, Toggle, useDialog } from '../../common/ui';
import { t } from '../../i18n';

const PROMPT_MAX_LINES = 2;

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 解析 core 的 filePath（`绝对路径[:起始行[-结束行]]`）为相对 workingDir 的路径 + 行范围 */
export function parseCronFileRef(filePath: string, workingDir: string): { path: string; line?: number; endLine?: number } | null {
  const m = filePath.match(/^(.+?)(?::(\d+)(?:-(\d+))?)?$/);
  if (!m) return null;
  let p = m[1];
  if (workingDir && (p.startsWith(workingDir + '/') || p.startsWith(workingDir + '\\'))) p = p.slice(workingDir.length + 1);
  return { path: p, line: m[2] ? Number(m[2]) : undefined, endLine: m[3] ? Number(m[3]) : undefined };
}

/** 定时任务卡片：右侧栏标签与日程页共用，操作通过回调注入；onEdit 缺省时不显示编辑按钮 */
export function CronTaskCard({ task, expanded, onToggleExpand, onToggle, onDelete, onEdit }: {
  task: CronTask; expanded: boolean;
  onToggleExpand: () => void; onToggle: (v: boolean) => void; onDelete: () => void; onEdit?: () => void;
}) {
  const dialog = useDialog();
  const [promptOpen, setPromptOpen] = useState(false);
  const name = task.title || task.id;

  const confirmDelete = async () => {
    if (await dialog.confirm({ title: t('cron.delete'), message: t('cron.confirmDelete', { name }), danger: true, okText: t('cron.delete') })) onDelete();
  };

  const lines = task.task.split('\n');
  const truncated = !promptOpen && lines.length > PROMPT_MAX_LINES;
  const promptText = truncated ? lines.slice(0, PROMPT_MAX_LINES).join('\n') : task.task;

  return (
    <div data-cron={task.id} className={cn('rounded-lg border border-border bg-white text-[13px]', !task.status && 'opacity-70')}>
      <div className="flex items-center gap-2 px-2 h-10 cursor-pointer select-none" onClick={onToggleExpand}>
        {expanded ? <ChevronDown size={13} className="shrink-0 text-muted" /> : <ChevronRight size={13} className="shrink-0 text-muted" />}
        <div className="flex-1 min-w-0 leading-tight">
          <div className="truncate font-medium text-fg" title={name}>{name}</div>
          <div className="truncate text-[11px] text-muted">{task.describeCronExpression}</div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
          {onEdit && <button onClick={onEdit} className="h-6 w-6 inline-flex items-center justify-center rounded text-muted hover:text-fg hover:bg-black/[0.05]" title={t('cron.edit')}><Pencil size={13} /></button>}
          <button onClick={confirmDelete} className="h-6 w-6 inline-flex items-center justify-center rounded text-muted hover:text-danger hover:bg-danger/10" title={t('cron.delete')}><Trash2 size={13} /></button>
          <span className="ml-1 inline-flex items-center scale-90"><Toggle checked={task.status} onChange={onToggle} /></span>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border px-3 py-2 flex flex-col gap-2">
          <div className="flex items-center gap-1.5 flex-wrap text-xs">
            <span className="text-muted">Cron:</span>
            <code className="font-mono px-1.5 py-0.5 rounded bg-code border border-border">
              {task.schedule.split('').map((ch, i) => ch === '*' || ch === ' ' ? ch : <span key={i} className="text-accent font-semibold">{ch}</span>)}
            </code>
            <Tag>{task.repeat ? t('cron.repeat') : t('cron.once')}</Tag>
            <Tag>{task.persist ? t('cron.persist') : t('cron.sessionOnly')}</Tag>
          </div>
          <div className="text-[11px] text-muted">{task.id} · {fmtDateTime(task.createdAt)}</div>
          <div>
            <div className="text-xs text-muted mb-1">Prompt:</div>
            <pre className="font-mono text-[12px] leading-5 whitespace-pre-wrap break-words rounded-md bg-code border border-border p-2">{promptText}</pre>
            {lines.length > PROMPT_MAX_LINES && (
              <button onClick={() => setPromptOpen(v => !v)} className="mt-1 text-xs text-muted hover:text-fg">
                {promptOpen ? t('cron.collapsePrompt') : t('cron.morePrompt', { n: lines.length - PROMPT_MAX_LINES })}
              </button>
            )}
          </div>
          {task.nextFireAt.length > 0 && (
            <div>
              <div className="text-xs text-muted mb-1">{t('cron.nextFire')}:</div>
              <pre className="font-mono text-[12px] leading-5 rounded-md bg-code border border-border p-2">{task.nextFireAt.map(fmtDateTime).join('\n')}</pre>
            </div>
          )}
          {task.lastFiredAt != null && <div className="text-[11px] text-muted">{t('cron.lastFired')}: {fmtDateTime(task.lastFiredAt)}</div>}
        </div>
      )}
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="px-1.5 py-0.5 rounded bg-black/[0.06] text-[11px] text-muted">{children}</span>;
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, ClipboardList } from 'lucide-react';
import type { PickBlock } from '../../../../shared/types';
import { useSessions } from '../../store/sessions';
import { Button, cn } from '../../common/ui';
import { t } from '../../i18n';
import type { BlockCtx } from './Blocks';

/** ask_form 题目类型（与 core 一致） */
type Question =
  | { type: 'radio'; id: string; label: string; required?: boolean; options: string[] }
  | { type: 'checkbox'; id: string; label: string; required?: boolean; options: string[]; maxSelections?: number }
  | { type: 'select'; id: string; label: string; required?: boolean; options: string[] }
  | { type: 'text'; id: string; label: string; required?: boolean; placeholder?: string; maxLength?: number; defaultValue?: string }
  | { type: 'textarea'; id: string; label: string; required?: boolean; placeholder?: string; maxLength?: number; defaultValue?: string };

type Values = Record<string, string | string[]>;

const DEFAULT_TEXT_MAX = 100;
const DEFAULT_TEXTAREA_MAX = 500;
/** Other 选项：纯前端概念，后端无感知 */
const OTHER_LABEL = 'Other';
const OTHER_SELECT_SENTINEL = '__ask_form_other__';
const OTHER_INPUT_MAX = 200;
const MULTI_SEP = '; ';

const isChoice = (q: Question) => q.type === 'radio' || q.type === 'checkbox' || q.type === 'select';
const isAnswered = (q: Question, v: string | string[] | undefined) => q.type === 'checkbox' ? Array.isArray(v) && v.length > 0 : typeof v === 'string' && v.trim().length > 0;
const formatValue = (q: Question, v: string | string[] | undefined) => !isAnswered(q, v) ? '(skipped)' : q.type === 'checkbox' ? (v as string[]).join(MULTI_SEP) : (v as string).trim();
/** 答案文本（发给模型）：`- label: value` 逐行 */
const formatAnswers = (qs: Question[], values: Values) => qs.map(q => `- ${q.label}: ${formatValue(q, values[q.id])}`).join('\n');

/** 从已回答的答案文本反解出各题的值（用于只读回显） */
function parseAnswers(qs: Question[], text: string | null | undefined): Values {
  const values: Values = {};
  const lines = (text || '').split('\n');
  for (const q of qs) {
    const line = lines.find(l => l.startsWith(`- ${q.label}: `));
    const raw = line ? line.slice(`- ${q.label}: `.length).trim() : '';
    const v = raw === '(skipped)' ? '' : raw;
    values[q.id] = q.type === 'checkbox' ? (v ? v.split(MULTI_SEP) : []) : v;
  }
  return values;
}

interface FormState { values: Values; otherActive: Record<string, boolean>; otherText: Record<string, string> }

/** 把外部 values 拆成「真实选项」与「Other 状态」：不在 options 内的值识别为 Other */
function buildState(qs: Question[], initial?: Values): FormState {
  const values: Values = {}, otherActive: Record<string, boolean> = {}, otherText: Record<string, string> = {};
  for (const q of qs) {
    const raw = initial?.[q.id];
    if (q.type === 'checkbox') {
      const arr = Array.isArray(raw) ? raw : [];
      values[q.id] = arr.filter(x => q.options.includes(x));
      const others = arr.filter(x => !q.options.includes(x));
      if (others.length) { otherActive[q.id] = true; otherText[q.id] = others.join(MULTI_SEP); }
    } else if (q.type === 'radio' || q.type === 'select') {
      const s = typeof raw === 'string' ? raw : '';
      if (s && !q.options.includes(s)) { values[q.id] = ''; otherActive[q.id] = true; otherText[q.id] = s; } else values[q.id] = s;
    } else {
      values[q.id] = typeof raw === 'string' ? raw : (q.defaultValue ?? '');
    }
  }
  return { values, otherActive, otherText };
}

/** 提问卡片：快速确认表单（chip 单选/多选 + Other、下拉、文本/多行带计数、必填校验、已回答只读回显） */
export function PickCard({ block, ctx }: { block: PickBlock; ctx: BlockCtx }) {
  const respond = useSessions(s => s.respondPick);
  const questions = (block.questions || []) as Question[];
  const readonly = !!block.answered;
  const init = useMemo(() => buildState(questions, readonly ? parseAnswers(questions, block.resolved) : undefined), [block.id, readonly, block.resolved]); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Values>(init.values);
  const [otherActive, setOtherActive] = useState(init.otherActive);
  const [otherText, setOtherText] = useState(init.otherText);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(!readonly); // 已回答默认折叠，点头部可展开
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 回答后（可能来自本地乐观更新）同步为只读回显
  useEffect(() => { if (readonly) { setValues(init.values); setOtherActive(init.otherActive); setOtherText(init.otherText); setOpen(false); } }, [readonly, init]);
  useEffect(() => { if (!readonly) boxRef.current?.focus(); }, [readonly]);

  const clearError = (id: string) => setErrors(e => { if (!e[id]) return e; const n = { ...e }; delete n[id]; return n; });
  const setValue = (id: string, v: string | string[]) => { setValues(p => ({ ...p, [id]: v })); clearError(id); };
  const setOther = (id: string, active: boolean) => { setOtherActive(p => ({ ...p, [id]: active })); clearError(id); };
  const setOtherTxt = (id: string, s: string) => { setOtherText(p => ({ ...p, [id]: s })); clearError(id); };

  /** 真实选项 + Other 文本 → 最终答案 */
  const finalValues = (): Values => {
    const r: Values = {};
    for (const q of questions) {
      const ot = (otherText[q.id] || '').trim();
      if (q.type === 'checkbox') { const real = (values[q.id] as string[]) || []; r[q.id] = otherActive[q.id] && ot ? [...real, ot] : [...real]; }
      else if (q.type === 'radio' || q.type === 'select') r[q.id] = otherActive[q.id] ? ot : ((values[q.id] as string) || '');
      else r[q.id] = values[q.id];
    }
    return r;
  };

  const send = async (answers: string) => { setBusy(true); try { await respond(ctx.sessionId, block.id, block.agentId, answers); } finally { setBusy(false); } };
  const submit = () => {
    const fv = finalValues();
    const errs: Record<string, string> = {};
    for (const q of questions) if (q.required && !isAnswered(q, fv[q.id])) errs[q.id] = isChoice(q) && otherActive[q.id] ? '请填写 Other 内容' : '此项为必填';
    if (Object.keys(errs).length) { setErrors(errs); return; }
    void send(formatAnswers(questions, fv));
  };
  const skip = () => void send(formatAnswers(questions, finalValues()));

  const chip = (selected: boolean, disabled: boolean) => cn(
    'h-7 px-3 rounded-full border text-[13px] transition-colors',
    selected ? 'border-accent bg-accent/10 text-accent' : 'border-border bg-bg text-fg hover:border-dim',
    disabled && 'opacity-50 cursor-not-allowed',
  );
  const inputCls = 'w-full px-2.5 rounded-md bg-bg border border-border text-[13px] focus:outline-none focus:border-accent disabled:opacity-70';

  const otherInput = (q: Question) => (
    <input type="text" value={otherText[q.id] || ''} placeholder="请输入其他内容..." disabled={readonly} maxLength={OTHER_INPUT_MAX}
      onChange={e => setOtherTxt(q.id, e.target.value.slice(0, OTHER_INPUT_MAX))} className={cn(inputCls, 'h-8 mt-2')} />
  );

  const renderQuestion = (q: Question) => {
    const v = values[q.id];
    const err = errors[q.id];
    const otherSel = !!otherActive[q.id];
    let body: React.ReactNode = null;
    if (q.type === 'radio') {
      body = (
        <>
          <div className="flex flex-wrap gap-1.5">
            {q.options.map(opt => { const on = !otherSel && v === opt; return (
              <button key={opt} type="button" disabled={readonly} className={chip(on, readonly)} onClick={() => { setOther(q.id, false); setValue(q.id, on ? '' : opt); }}>{opt}</button>
            ); })}
            <button type="button" disabled={readonly} className={chip(otherSel, readonly)} onClick={() => { setOther(q.id, true); setValues(p => ({ ...p, [q.id]: '' })); }}>{OTHER_LABEL}</button>
          </div>
          {otherSel && otherInput(q)}
        </>
      );
    } else if (q.type === 'checkbox') {
      const arr = (v as string[]) || [];
      const max = q.maxSelections;
      const count = arr.length + (otherSel ? 1 : 0);
      const full = !!max && count >= max;
      body = (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {q.options.map(opt => { const on = arr.includes(opt); const dis = readonly || (full && !on); return (
              <button key={opt} type="button" disabled={dis} className={chip(on, dis)} onClick={() => setValue(q.id, on ? arr.filter(x => x !== opt) : [...arr, opt])}>{opt}</button>
            ); })}
            <button type="button" disabled={readonly || (full && !otherSel)} className={chip(otherSel, readonly || (full && !otherSel))} onClick={() => setOther(q.id, !otherSel)}>{OTHER_LABEL}</button>
            {max ? <span className="text-xs text-muted ml-1">最多选择 {max} 项（已选 {count}/{max}）</span> : null}
          </div>
          {otherSel && otherInput(q)}
        </>
      );
    } else if (q.type === 'select') {
      body = (
        <>
          <select value={otherSel ? OTHER_SELECT_SENTINEL : ((v as string) || '')} disabled={readonly} className={cn(inputCls, 'h-8 max-w-xs')}
            onChange={e => { const val = e.target.value; if (val === OTHER_SELECT_SENTINEL) { setOther(q.id, true); setValues(p => ({ ...p, [q.id]: '' })); } else { setOther(q.id, false); setValue(q.id, val); } }}>
            <option value="">请选择...</option>
            {q.options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            <option value={OTHER_SELECT_SENTINEL}>{OTHER_LABEL}...</option>
          </select>
          {otherSel && otherInput(q)}
        </>
      );
    } else {
      const max = q.maxLength ?? (q.type === 'text' ? DEFAULT_TEXT_MAX : DEFAULT_TEXTAREA_MAX);
      const text = (v as string) || '';
      body = (
        <div className="relative">
          {q.type === 'text'
            ? <input type="text" value={text} placeholder={q.placeholder} disabled={readonly} maxLength={max} onChange={e => setValue(q.id, e.target.value.slice(0, max))} className={cn(inputCls, 'h-8 pr-14')} />
            : <textarea value={text} placeholder={q.placeholder} disabled={readonly} rows={3} maxLength={max} onChange={e => setValue(q.id, e.target.value.slice(0, max))} className={cn(inputCls, 'py-1.5 pr-14 resize-y')} />}
          <span className="absolute right-2 bottom-1.5 text-[11px] text-dim select-none">{text.length}/{max}</span>
        </div>
      );
    }
    return (
      <div key={q.id}>
        <div className="mb-1.5 text-[13px]">{q.label}{q.required && <span className="text-danger ml-0.5">*</span>}</div>
        {body}
        {err && <div className="mt-1 text-xs text-danger">{err}</div>}
      </div>
    );
  };

  const title = block.estimatedTime ? `快速确认（${block.estimatedTime}）` : '快速确认';

  return (
    <div ref={boxRef} tabIndex={readonly ? -1 : 0} className={cn('my-2 rounded-lg border text-sm outline-none', readonly ? 'border-border bg-panel-2' : 'border-accent/50 bg-accent/5')}>
      <button type="button" onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left" title={open ? '收起' : '展开'}>
        {open ? <ChevronDown size={14} className="text-muted shrink-0" /> : <ChevronRight size={14} className="text-muted shrink-0" />}
        <ClipboardList size={14} className={readonly ? 'text-muted' : 'text-accent'} />
        <div className="flex-1 min-w-0">
          <div className="font-medium">{title}</div>
          {block.intro && <div className="text-xs text-muted truncate">{block.intro}</div>}
        </div>
        <span className={cn('text-[11px] px-2 h-5 inline-flex items-center rounded-full border shrink-0', readonly ? 'border-border text-muted' : 'border-accent/40 text-accent bg-accent/10')}>{readonly ? '已回答' : '待回答'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-3">
          {questions.map(renderQuestion)}
          {!readonly && (
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={busy} onClick={submit}>{t('card.submit')}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={skip}>{t('card.skip')}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

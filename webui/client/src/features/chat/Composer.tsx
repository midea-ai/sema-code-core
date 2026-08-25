import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useApp } from '../../store/app';
import { useSessions } from '../../store/sessions';
import { pendingBlocks } from '../../../../shared/transcript';
import { wsClient } from '../../api/ws';
import { Dropdown, cn } from '../../common/ui';
import ProviderLogo, { parseProviderKey, stripProviderSuffix } from '../../common/ProviderLogo';
import { t } from '../../i18n';
import { PERMISSION_LEVELS, normalizeLevel } from '../../../../shared/types';
import type { AgentMode, PermissionLevel, FileSearchItem, SlashItem } from '../../../../shared/types';
import { CommandPanel, FilePicker, filterSlash, findAtTrigger, findSlashTrigger, formatFileRef, useCommands, useFileSearch, type PickerTrigger } from './InputPickers';
import { ImageThumb } from './ImagePreview';

const MODES: AgentMode[] = ['Agent', 'Plan', 'Design'];
const LEVELS = PERMISSION_LEVELS;
const ACCEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// 模式/档位按钮状态色（对齐插件：Agent/Ask 灰，Plan/AutoRun 黄，AutoEdit 绿，Bypass 红，Design 紫）
const NEUTRAL_TONE = 'bg-black/[0.04] text-muted hover:text-fg hover:bg-black/[0.07]';
const MODE_TONE: Partial<Record<AgentMode, string>> = {
  Agent: NEUTRAL_TONE,
  Plan: 'bg-warn/10 text-warn hover:bg-warn/15',
  Design: 'bg-design/10 text-design hover:bg-design/15',
};
const LEVEL_TONE: Record<PermissionLevel, string> = {
  AutoEdit: 'bg-ok/10 text-ok hover:bg-ok/15',
  AutoRun: 'bg-warn/10 text-warn hover:bg-warn/15',
  Bypass: 'bg-danger/8 text-danger hover:bg-danger/15',
};

export const DRAFT_KEY = '__draft__';

/** sessionId 为空 = 新会话草稿模式：首次发送时才创建会话并跳转 */
export function Composer({ sessionId, projectId }: { sessionId?: string; projectId?: string }) {
  const isDraft = !sessionId;
  const draftKey = sessionId || DRAFT_KEY;
  const snap = useSessions(s => sessionId ? s.snapshots[sessionId] : undefined);
  const draft = useSessions(s => s.drafts[draftKey]) || { text: '', images: [] };
  const setDraft = useSessions(s => s.setDraft);
  const send = useSessions(s => s.send);
  const interrupt = useSessions(s => s.interrupt);
  const setAgentMode = useSessions(s => s.setAgentMode);
  const setPermissionLevel = useSessions(s => s.setPermissionLevel);
  const modelData = useApp(s => s.modelData);
  const setView = useApp(s => s.setView);
  const toast = useApp(s => s.toast);
  const wsStatus = useApp(s => s.wsStatus);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 草稿模式下模式/档位先记着，创建会话后再下发；模式提在 store 里，DraftView 据此切换 Design 版新会话样式
  const draftMode = useSessions(s => s.draftAgentMode);
  const setDraftMode = useSessions(s => s.setDraftAgentMode);
  const defaultLevel = normalizeLevel(useApp(s => s.settings?.defaultPermissionLevel));
  const [draftLevel, setDraftLevel] = useState<PermissionLevel>(defaultLevel);
  // @ 文件选择器 / 斜杠命令面板：由光标位置的文本判定是否打开；selIdx 为当前高亮项
  const [trigger, setTrigger] = useState<PickerTrigger | null>(null);
  const [selIdx, setSelIdx] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const scope = { sessionId, projectId };
  const fileSearch = useFileSearch(scope, trigger?.kind === 'file' && (sessionId || projectId) ? trigger.query : null);
  const cmds = useCommands(scope, trigger?.kind === 'cmd');
  const cmdItems = trigger?.kind === 'cmd' ? filterSlash(cmds.items, trigger.query) : [];

  const processing = snap?.state === 'processing';
  const pending = snap ? pendingBlocks(snap).length : 0;
  const hasModel = !!modelData?.modelList?.length;
  const disabled = (isDraft ? false : !snap || pending > 0) || wsStatus !== 'open';
  const agentMode = isDraft ? draftMode : (snap?.agentMode || 'Agent');
  const permissionLevel = isDraft ? draftLevel : normalizeLevel(snap?.permissionLevel || defaultLevel);
  // Design 模式与 Agent/Plan 不同：不能在已有会话里就地切入，选中后回到新会话草稿页并预选 Design，
  // 与默认新会话一致：首次发送时才真正创建会话
  const changeMode = (m: AgentMode) => {
    if (isDraft) { setDraftMode(m); return; }
    if (m === 'Design' && agentMode !== 'Design') {
      const pid = useApp.getState().registry.sessions.find(s => s.id === sessionId)?.projectId;
      setDraftMode('Design');
      setView({ type: 'draft', projectId: pid });
      return;
    }
    setAgentMode(sessionId!, m).catch(e => toast(e.message, 'error'));
  };
  const changeLevel = (l: PermissionLevel) => { if (isDraft) setDraftLevel(l); else setPermissionLevel(sessionId!, l).catch(e => toast(e.message, 'error')); };

  // 自动高度
  useEffect(() => {
    const el = taRef.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [draft.text]);

  useEffect(() => { taRef.current?.focus(); }, [draftKey]);

  // 补全后把光标放到指定位置（文本更新在下一次渲染才落到 DOM）
  useEffect(() => {
    if (pendingCaret.current === null) return;
    const el = taRef.current; const pos = pendingCaret.current; pendingCaret.current = null;
    if (el) { el.focus(); el.setSelectionRange(pos, pos); }
  }, [draft.text]);

  /** 按当前文本与光标重新判定弹层（onChange / 光标移动 / 点击时调用） */
  const updateTrigger = useCallback((text: string, caret: number) => {
    setTrigger(findAtTrigger(text, caret) || findSlashTrigger(text, caret));
  }, []);
  // 触发内容变化（换了 query / 换了 @ 位置 / 切换面板）时高亮回到第一项
  const triggerKey = trigger ? `${trigger.kind}:${trigger.kind === 'file' ? trigger.start : ''}:${trigger.query}` : '';
  useEffect(() => { setSelIdx(0); }, [triggerKey]);
  const closePicker = () => setTrigger(null);
  const syncCaret = () => { const el = taRef.current; if (el) updateTrigger(el.value, el.selectionStart ?? el.value.length); };

  const replaceRange = (start: number, end: number, insert: string) => {
    const text = draft.text.slice(0, start) + insert + draft.text.slice(end);
    pendingCaret.current = start + insert.length;
    setDraft(draftKey, d => ({ ...d, text }));
    setTrigger(null);
  };
  const pickFile = (f: FileSearchItem) => {
    if (trigger?.kind !== 'file') return;
    const after = draft.text.slice(trigger.end);
    const needSpace = !after || !/^[\s]/.test(after);
    replaceRange(trigger.start, trigger.end, formatFileRef(f.path) + (needSpace ? ' ' : ''));
  };
  const pickCommand = (c: SlashItem) => {
    if (c.send) { setTrigger(null); doSend(`/${c.name}`); return; }
    const first = draft.text.match(/^\/(\S*)/)![0];
    replaceRange(0, first.length, `/${c.name} `);
  };

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!ACCEPT.includes(f.type)) continue;
      if (f.size > 8 * 1024 * 1024) { toast('图片超过 8MB，已忽略', 'warn'); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const data = dataUrl.split(',')[1] || '';
        setDraft(draftKey, d => ({ ...d, images: [...d.images, { dataUrl, media_type: f.type, data }] }));
      };
      reader.readAsDataURL(f);
    }
  }, [draftKey, setDraft, toast]);

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };

  const doSend = async (override?: string) => {
    const text = (override ?? draft.text).trim();
    const images = override ? [] : draft.images; // 面板直发的内置命令（/clear /compact）不带图片
    if ((!text && images.length === 0) || disabled || sending) return;
    setTrigger(null);
    if (!hasModel) { toast(t('chat.noModel'), 'warn'); setView({ type: 'settings', tab: 'models' }); return; }
    setSending(true);
    try {
      if (isDraft) {
        // 首次发送才创建会话记录：建会话 → 下发非默认模式/档位 → 切到会话页 → 发送；失败保留草稿
        const rec = await useApp.getState().createSession(projectId);
        const sessions = useSessions.getState();
        if (draftMode !== 'Agent') await sessions.setAgentMode(rec.id, draftMode);
        if (draftLevel !== defaultLevel) await sessions.setPermissionLevel(rec.id, draftLevel);
        await sessions.send(rec.id, text, images);
        sessions.setDraft(DRAFT_KEY, () => ({ text: '', images: [] }));
        sessions.setDraftAgentMode('Agent');
        setView({ type: 'chat', sessionId: rec.id });
      } else {
        await send(sessionId!, text, images);
      }
    } catch (e: any) { toast(e.message, 'error'); } finally { setSending(false); }
    taRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    // 弹层打开时接管 ↑↓ Tab Enter Esc
    if (trigger) {
      const count = trigger.kind === 'file' ? fileSearch.items.length : cmdItems.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (count > 0) setSelIdx(i => e.key === 'ArrowDown' ? (i + 1) % count : (i - 1 + count) % count);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        if (count > 0) {
          e.preventDefault();
          const idx = Math.min(selIdx, count - 1);
          if (trigger.kind === 'file') pickFile(fileSearch.items[idx]); else pickCommand(cmdItems[idx]);
          return;
        }
        if (e.key === 'Tab') { e.preventDefault(); return; }
        // 无候选：Enter 照常发送
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    if (e.key === 'Escape' && processing && sessionId) interrupt(sessionId).catch(() => undefined);
  };
  // 方向键/Home/End 等移动光标后重新判定（keydown 时光标还没动）
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key) || (!trigger && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) syncCaret();
  };

  const usage = snap?.usage;
  const usagePct = usage && usage.maxTokens ? Math.min(100, (usage.useTokens / usage.maxTokens) * 100) : null;

  return (
    <div className="shrink-0 px-4 pb-3 pt-2">
      <div className="max-w-3xl mx-auto">
        {!hasModel && modelData && (
          <div className="mb-2 text-xs rounded-md border border-warn/40 bg-warn/10 px-3 py-1.5 flex items-center gap-2">
            <span>{t('chat.noModel')}</span>
            <button className="underline" onClick={() => setView({ type: 'settings', tab: 'models' })}>{t('chat.goConfigModel')}</button>
          </div>
        )}
        {pending > 0 && <div className="mb-1.5 text-xs text-warn px-1">{t('chat.waitingPermission')}</div>}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          className={cn('relative rounded-xl border bg-white transition-[border-color,box-shadow] focus-within:border-accent/60 focus-within:ring-1 focus-within:ring-accent/25', dragOver ? 'border-accent' : 'border-border')}>
          {draft.images.length > 0 && (
            <div className="flex gap-2 px-3.5 pt-3 flex-wrap">
              {draft.images.map((img, i) => (
                <ImageThumb key={i} src={img.dataUrl} className="h-20 w-20"
                  onDelete={() => setDraft(draftKey, d => ({ ...d, images: d.images.filter((_, j) => j !== i) }))} />
              ))}
            </div>
          )}
          {trigger?.kind === 'file' && (
            <FilePicker items={fileSearch.items} loading={fileSearch.loading} selected={selIdx} noScope={!sessionId && !projectId} onSelect={pickFile} onHover={setSelIdx} />
          )}
          {trigger?.kind === 'cmd' && (
            <CommandPanel items={cmdItems} loading={cmds.loading} selected={selIdx} onSelect={pickCommand} onHover={setSelIdx} />
          )}
          <textarea ref={taRef} rows={1} value={draft.text} disabled={disabled}
            onChange={e => { setDraft(draftKey, d => ({ ...d, text: e.target.value })); updateTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length); }}
            onKeyDown={onKeyDown} onKeyUp={onKeyUp} onClick={syncCaret} onBlur={closePicker} onPaste={onPaste} placeholder={t('chat.placeholder')}
            className="w-full bg-transparent resize-none px-3.5 pt-3.5 pb-1.5 text-sm leading-[22px] min-h-[52px] placeholder:text-muted/60 max-h-60" />
          {/* 底栏：左侧裸按钮 28px 等高，右侧用量 + 32px 发送键，全部垂直居中 */}
          <div className="h-11 flex items-center gap-0.5 pl-2 pr-2">
            <Dropdown value={agentMode} title={t('chat.mode')} options={MODES.map(m => ({
              value: m,
              label: m === 'Design'
                ? <span className="inline-flex items-center gap-1.5">{t('mode.Design')}<span className="text-[9px] leading-none px-1 py-0.5 rounded bg-black/[0.06] text-muted font-medium">beta</span></span>
                : t(`mode.${m}` as any),
            }))}
              onChange={changeMode} compact tone={MODE_TONE[agentMode] || NEUTRAL_TONE}
              renderValue={v => <span>{t(`mode.${v}` as any)}</span>} />
            <span className="mx-1 h-4 border-l border-border" />
            <Dropdown value={modelData?.taskConfig?.main || ''} title={t('chat.model')} minWidth={220}
              options={(modelData?.modelList || []).map(m => ({ value: m, label: stripProviderSuffix(m), icon: <ProviderLogo provider={parseProviderKey(m)} /> }))}
              onChange={async m => { try { await wsClient.request('core.switchModel', undefined, { modelName: m }); await useApp.getState().refreshModelData(); } catch (e: any) { toast(e.message, 'error'); } }}
              renderValue={v => v
                ? <><ProviderLogo provider={parseProviderKey(v)} /><span className="max-w-44 truncate">{stripProviderSuffix(v)}</span></>
                : <span className="text-muted">{modelData ? t('chat.noModel') : t('common.loading')}</span>}
              footer={close => (
                <button onClick={() => { close(); setView({ type: 'settings', tab: 'models' }); }} className="w-full text-left px-3 py-1.5 rounded hover:bg-black/[0.05] text-sm">{t('settings.manageModels')}</button>
              )} />
            <span className="mx-1 h-4 border-l border-border" />
            <Dropdown value={permissionLevel} title={t('chat.permission')}
              options={LEVELS.map(l => ({ value: l, label: t(`level.${l}` as any), desc: t(`level.${l}.desc` as any) }))}
              onChange={changeLevel} compact tone={LEVEL_TONE[permissionLevel]}
              renderValue={v => <span>{t(`level.${v}` as any)}</span>} />
            <span className="flex-1" />
            {usagePct !== null && <TokenProgress useTokens={usage!.useTokens} maxTokens={usage!.maxTokens} />}
            {processing ? (
              <button onClick={() => interrupt(sessionId!).catch(e => toast(e.message, 'error'))} title={t('chat.stop')}
                className="h-8 w-8 rounded-full bg-primary hover:bg-black text-white flex items-center justify-center"><Square size={12} fill="currentColor" /></button>
            ) : (
              <button onClick={() => doSend()} disabled={disabled || sending || (!draft.text.trim() && !draft.images.length)} title={t('chat.send')}
                className="h-8 w-8 rounded-full flex items-center justify-center transition-colors bg-primary hover:bg-black text-white disabled:bg-black/[0.08] disabled:text-muted/60 disabled:cursor-default"><ArrowUp size={16} strokeWidth={2.25} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 上下文用量：圆环 + 百分比（对齐插件 TokenProgress）；低占用只显圆环，hover 才显示数字 */
function TokenProgress({ useTokens, maxTokens }: { useTokens: number; maxTokens: number }) {
  const pct = maxTokens > 0 ? Math.min((useTokens / maxTokens) * 100, 100) : 0;
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const low = pct < 50;
  const ring = pct > 85 ? 'stroke-danger' : pct > 60 ? 'stroke-warn' : 'stroke-fg/70';
  const text = pct > 85 ? 'text-danger' : 'text-muted';
  return (
    <div className="group flex items-center gap-1 h-7 px-1.5 mr-1.5 rounded-md select-none hover:bg-black/[0.04]" title={`${t('chat.usage')}已使用 ${fmt(useTokens)} / ${fmt(maxTokens)} tokens`}>
      <span className={cn('text-[11px] tabular-nums tracking-wide', text, low && 'hidden group-hover:inline')}>{pct.toFixed(1)}%</span>
      <svg viewBox="0 0 36 36" className="w-3.5 h-3.5 -rotate-90 shrink-0">
        <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" className="stroke-black/10" />
        <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" strokeLinecap="round" className={cn('transition-[stroke-dasharray] duration-300', ring)} strokeDasharray={`${pct * 0.974}, 100`} />
      </svg>
    </div>
  );
}

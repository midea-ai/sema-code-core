import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import { useApp } from '../../store/app';
import { useSessions, emptyDraft, type DraftPaste } from '../../store/sessions';
import { pendingBlocks } from '../../../../shared/transcript';
import { buildPasteInput } from '../../../../shared/paste';
import { wsClient } from '../../api/ws';
import { api } from '../../api/http';
import { Dropdown, cn } from '../../common/ui';
import ProviderLogo, { parseProviderKey, stripProviderSuffix } from '../../common/ProviderLogo';
import { t } from '../../i18n';
import { PERMISSION_LEVELS, normalizeLevel } from '../../../../shared/types';
import type { AgentMode, PermissionLevel, FileSearchItem, SlashItem } from '../../../../shared/types';
import { CommandPanel, FilePicker, filterSlash, findAtTrigger, findSlashTrigger, formatFileRef, useCommands, useFileSearch, type PickerTrigger } from './InputPickers';
import { ImageThumb } from './ImagePreview';
import { SkillLabel, matchSkillPrefix } from './skillDisplay';
import { RefEditor, type EditorSegment, type RefEditorHandle } from './RefEditor';
import { FileRefChip, refPaths, refStatPath, splitFileRefs, type RefSegment } from './fileRefDisplay';
import { primeStat, usePathStats } from './fileRefs';
import { PasteChip, PASTE_CHIP_HEIGHT, PASTE_SAVE_FAILED, isLongPaste, makePastePreview } from './pasteAttachment';

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
  const draft = useSessions(s => s.drafts[draftKey]) || emptyDraft();
  const setDraft = useSessions(s => s.setDraft);
  const send = useSessions(s => s.send);
  const interrupt = useSessions(s => s.interrupt);
  const setAgentMode = useSessions(s => s.setAgentMode);
  const setPermissionLevel = useSessions(s => s.setPermissionLevel);
  const modelData = useApp(s => s.modelData);
  const setView = useApp(s => s.setView);
  const toast = useApp(s => s.toast);
  const wsStatus = useApp(s => s.wsStatus);
  const openFileRef = useApp(s => s.openFileRef);
  const taRef = useRef<RefEditorHandle>(null);
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
  // ↑↓ 历史输入切换：histIdx 为当前所在的历史下标（null=未在翻历史），histSaved 保存进入翻页前未发送的草稿
  const histIdx = useRef<number | null>(null);
  const histSaved = useRef('');
  // 本次 ↑↓ 已被翻历史消费：keyup 跳过弹层重判，避免召回的 /命令 打开命令弹层抢走 ↑↓
  const histConsumed = useRef(false);
  // 草稿页还没有会话快照：从 server 拉项目目录的历史输入供 ↑↓ 翻页（无项目的草稿没有目录归属，不拉取）
  const [draftHistory, setDraftHistory] = useState<string[]>([]);
  useEffect(() => {
    setDraftHistory([]);
    histIdx.current = null;
    if (!isDraft || !projectId) return;
    let stale = false;
    api<string[]>('GET', `/api/projects/${projectId}/input-history`)
      .then(h => { if (!stale && Array.isArray(h)) setDraftHistory(h); })
      .catch(() => undefined);
    return () => { stale = true; };
  }, [isDraft, projectId]);
  // 草稿页选中项目即预热该项目的 worker（core 初始化 + skills/commands 预载），首条消息免冷启动；失败静默
  useEffect(() => {
    if (!isDraft || !projectId || wsStatus !== 'open') return;
    wsClient.request('project.warm', undefined, { projectId }).catch(() => undefined);
  }, [isDraft, projectId, wsStatus]);
  // 编辑器分段：开头的 `/<映射技能> ` 显示为「图标 + 名字」标签，`@路径 ` 经服务端 stat 确认存在后显示为「文件图标 + 文件名」芯片，
  // 不存在的引用保持原文；draft.text 与发送内容始终是完整文本，所有光标/触发判定都按完整文本算，编辑器内部负责标签与全文坐标的换算。
  // 芯片点击在右栏打开文件；草稿页没有右栏，芯片只显示不响应
  const scopeId = sessionId || projectId;
  const refKeys = useMemo(() => refPaths(draft.text, false), [draft.text]);
  const stat = usePathStats(scopeId, refKeys, true);
  const openRef = useCallback((seg: RefSegment) => { if (sessionId) openFileRef(sessionId, seg.path, seg.line, seg.endLine); }, [sessionId, openFileRef]);
  const parse = useCallback((text: string): EditorSegment[] => {
    const segs: EditorSegment[] = [];
    let body = text;
    const sk = matchSkillPrefix(text, true);
    if (sk) { segs.push({ type: 'token', raw: `/${sk.name}`, node: <SkillLabel display={sk.display} /> }); body = text.slice(sk.name.length + 1); }
    for (const s of splitFileRefs(body, false)) {
      if (s.type === 'text') { segs.push(s); continue; }
      const st = stat(refStatPath(s.path));
      if (!st?.exists) { segs.push({ type: 'text', text: s.raw }); continue; }
      segs.push({ type: 'token', raw: s.raw, node: <FileRefChip seg={{ ...s, isDirectory: st.isDir }} onOpen={sessionId ? openRef : undefined} /> });
    }
    return segs;
  }, [sessionId, openRef, stat]);
  const scope = { sessionId, projectId };
  const fileSearch = useFileSearch(scope, trigger?.kind === 'file' && (sessionId || projectId) ? trigger.query : null);
  const cmds = useCommands(scope, trigger?.kind === 'cmd');
  const cmdItems = trigger?.kind === 'cmd' ? filterSlash(cmds.items, trigger.query) : [];

  const processing = snap?.state === 'processing';
  const pending = snap ? pendingBlocks(snap).length : 0;
  // 输入预测 ghost：仅空输入且会话空闲时展示，用户开始输入即自然消失（input:predict 事件写入快照）
  const ghost = (!processing && draft.text === '' && draft.images.length === 0 && draft.pastes.length === 0 && snap?.predictedInput) || undefined;
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

  useEffect(() => { taRef.current?.focus(); histIdx.current = null; }, [draftKey]);

  // 补全后把光标放到指定位置（文本更新在下一次渲染才落到 DOM；编辑器的重建在 layout effect 里，先于这里执行）
  useEffect(() => {
    if (pendingCaret.current === null) return;
    const pos = Math.max(0, pendingCaret.current); pendingCaret.current = null;
    taRef.current?.setCaret(pos);
  }, [draft.text]);

  /** 按当前文本与光标重新判定弹层（onChange / 光标移动 / 点击时调用） */
  const updateTrigger = useCallback((text: string, caret: number) => {
    setTrigger(findAtTrigger(text, caret) || findSlashTrigger(text, caret));
  }, []);
  // 触发内容变化（换了 query / 换了 @ 位置 / 切换面板）时高亮回到第一项
  const triggerKey = trigger ? `${trigger.kind}:${trigger.kind === 'file' ? trigger.start : ''}:${trigger.query}` : '';
  useEffect(() => { setSelIdx(0); }, [triggerKey]);
  const closePicker = () => setTrigger(null);
  const syncCaret = () => { const el = taRef.current; if (el) updateTrigger(draft.text, el.getCaret()); };
  /** 编辑器上报的就是完整文本与完整坐标 */
  const onChange = (text: string, caret: number) => {
    histIdx.current = null;
    setDraft(draftKey, d => ({ ...d, text }));
    updateTrigger(text, caret);
  };

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
    // 选择器给出的路径必然存在：预写 stat 缓存，补全后立即显示为芯片
    if (scopeId) primeStat(scopeId, refStatPath(f.path), { exists: true, isDir: f.isDirectory, inside: true, image: false });
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
      if (f.size > 8 * 1024 * 1024) { toast(t('chat.imageTooLarge'), 'warn'); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result);
        const data = dataUrl.split(',')[1] || '';
        setDraft(draftKey, d => ({ ...d, images: [...d.images, { dataUrl, media_type: f.type, data }] }));
      };
      reader.readAsDataURL(f);
    }
  }, [draftKey, setDraft, toast]);

  /** 在光标处插入文本（无光标信息时追加到末尾） */
  const insertAtCaret = (insert: string) => {
    const caret = taRef.current?.getCaret() ?? draft.text.length;
    replaceRange(caret, caret, insert);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files || []);
    if (files.length) { e.preventDefault(); addFiles(files); return; }
    // 超长文本粘贴那一刻就落盘为附件文件（与会话无关，草稿页也可用），输入框显示为粘贴芯片；转存失败退回原样粘贴
    const text = e.clipboardData.getData('text/plain');
    if (!text || !isLongPaste(text)) return;
    e.preventDefault();
    api<{ path: string }>('POST', '/api/attachments/paste', { text })
      .then(r => setDraft(draftKey, d => ({ ...d, pastes: [...d.pastes, { path: r.path, preview: makePastePreview(text), text }] })))
      .catch(() => { toast(PASTE_SAVE_FAILED, 'warn'); insertAtCaret(text); });
  };
  /** 删芯片：删掉服务端的 uuid 目录并从草稿移除（删除失败不阻塞 UI） */
  const removePaste = (p: DraftPaste) => {
    setDraft(draftKey, d => ({ ...d, pastes: d.pastes.filter(x => x.path !== p.path) }));
    api('POST', '/api/attachments/remove', { path: p.path }).catch(() => undefined);
  };
  /** 「在文本框中显示」：把粘贴内容展开回光标处，再删掉文件与芯片 */
  const showPasteInInput = (p: DraftPaste) => {
    insertAtCaret(p.text);
    removePaste(p);
  };

  const doSend = async (override?: string) => {
    const body = (override ?? draft.text).trim();
    const images = override ? [] : draft.images; // 面板直发的内置命令（/clear /compact）不带图片
    const pastes = override ? [] : draft.pastes;
    if ((!body && images.length === 0 && pastes.length === 0) || disabled || sending) return;
    // 有粘贴附件：模型收到的 input 按模板把粘贴文件以 @路径 引用；originalInput 传用户实际打的正文（没打字就是空串，不是不传）
    const text = pastes.length ? buildPasteInput(pastes, body) : body;
    const originalInput = pastes.length ? body : undefined;
    setTrigger(null);
    histIdx.current = null;
    if (!hasModel) { toast(t('chat.noModel'), 'warn'); setView({ type: 'settings', tab: 'models' }); return; }
    setSending(true);
    try {
      if (isDraft) {
        // 首次发送才创建会话记录：建会话 → 下发非默认模式/档位 → 切到会话页 → 发送；失败保留草稿
        const rec = await useApp.getState().createSession(projectId);
        const sessions = useSessions.getState();
        if (draftMode !== 'Agent') await sessions.setAgentMode(rec.id, draftMode);
        if (draftLevel !== defaultLevel) await sessions.setPermissionLevel(rec.id, draftLevel);
        await sessions.send(rec.id, text, images, originalInput);
        sessions.setDraft(DRAFT_KEY, () => emptyDraft());
        sessions.setDraftAgentMode('Agent');
        setView({ type: 'chat', sessionId: rec.id });
      } else {
        await send(sessionId!, text, images, originalInput);
      }
    } catch (e: any) { toast(e.message, 'error'); } finally { setSending(false); }
    taRef.current?.focus();
  };

  /** ↑↓ 切换项目历史输入：↑ 光标在首行时向更早翻，↓ 在末行时向更新翻，翻过最新一条恢复未发送草稿。
   * 返回 true 表示已消费按键；光标不在首/末行时不接管，保持正常的行内移动 */
  const historyNav = (key: string): boolean => {
    const list = snap ? snap.inputHistory : draftHistory;
    if (!list?.length) return false;
    const caret = taRef.current?.getCaret() ?? draft.text.length;
    const apply = (text: string) => { pendingCaret.current = text.length; setDraft(draftKey, d => ({ ...d, text })); };
    if (key === 'ArrowUp') {
      if (draft.text.slice(0, caret).includes('\n')) return false;
      const next = histIdx.current === null ? 0 : histIdx.current + 1;
      if (next >= list.length) return true; // 已是最早一条：吞掉按键，光标不跳
      if (histIdx.current === null) histSaved.current = draft.text;
      histIdx.current = next;
      apply(list[next]);
      return true;
    }
    if (histIdx.current === null || draft.text.slice(caret).includes('\n')) return false;
    const next = histIdx.current - 1;
    histIdx.current = next < 0 ? null : next;
    apply(next < 0 ? histSaved.current : list[next]);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    // ghost 可见时 Tab 采纳预测（空输入时 trigger 必为 null，与补全弹层不冲突）
    if (ghost && e.key === 'Tab') {
      e.preventDefault();
      pendingCaret.current = ghost.length;
      setDraft(draftKey, d => ({ ...d, text: ghost }));
      return;
    }
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
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && historyNav(e.key)) { e.preventDefault(); histConsumed.current = true; return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } // Shift+Enter 由编辑器插入换行
    if (e.key === 'Escape' && processing && sessionId) interrupt(sessionId).catch(() => undefined);
  };
  // 方向键/Home/End 等移动光标后重新判定（keydown 时光标还没动）
  const onKeyUp = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (histConsumed.current) { histConsumed.current = false; return; }
      if (!trigger) syncCaret();
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) syncCaret();
  };

  const usage = snap?.usage;
  const usagePct = usage && usage.maxTokens ? Math.min(100, (usage.useTokens / usage.maxTokens) * 100) : null;

  return (
    <div className="shrink-0 px-4 pb-3 pt-2">
      <div className="max-w-3xl mx-auto">
        {/* 未配置模型警告条只在已有会话里显示；草稿页由中间的引导卡片提示 */}
        {!hasModel && modelData && sessionId && (
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
          {(draft.images.length > 0 || draft.pastes.length > 0) && (
            <div className="flex gap-2 px-3.5 pt-3 flex-wrap items-start">
              {/* 只有图片时保持原大小；同排有粘贴芯片时缩到与芯片等高 */}
              {draft.images.map((img, i) => (
                <ImageThumb key={i} src={img.dataUrl} className={draft.pastes.length ? cn(PASTE_CHIP_HEIGHT, 'w-16') : 'h-20 w-20'}
                  onDelete={() => setDraft(draftKey, d => ({ ...d, images: d.images.filter((_, j) => j !== i) }))} />
              ))}
              {draft.pastes.map(p => (
                <PasteChip key={p.path} preview={p.preview} onDelete={() => removePaste(p)} onShowInInput={() => showPasteInInput(p)} />
              ))}
            </div>
          )}
          {trigger?.kind === 'file' && (
            <FilePicker items={fileSearch.items} loading={fileSearch.loading} selected={selIdx} noScope={!sessionId && !projectId} onSelect={pickFile} onHover={setSelIdx} />
          )}
          {trigger?.kind === 'cmd' && (
            <CommandPanel items={cmdItems} loading={cmds.loading} selected={selIdx} onSelect={pickCommand} onHover={setSelIdx} />
          )}
          {ghost && (
            // 与 textarea 同排版的灰色预测文字（ghost 仅在空输入时出现，此时 textarea 顶到容器顶部）
            <div className="pointer-events-none absolute inset-x-0 top-0 px-3.5 pt-3.5 text-sm leading-[22px] text-muted/50 truncate">
              {ghost}
              <span className="ml-2 text-[10px] leading-none px-1 py-0.5 rounded bg-black/[0.06] text-muted/70 align-middle whitespace-nowrap">{t('chat.predictAccept')}</span>
            </div>
          )}
          <RefEditor ref={taRef} value={draft.text} parse={parse} disabled={disabled}
            onChange={onChange}
            onKeyDown={onKeyDown} onKeyUp={onKeyUp} onClick={syncCaret} onBlur={closePicker} onPaste={onPaste} placeholder={ghost ? '' : t('chat.placeholder')}
            className="w-full px-3.5 pt-3.5 pb-1.5 text-sm leading-[22px] min-h-[52px] max-h-60 overflow-auto" />
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
            {usagePct !== null && <TokenProgress useTokens={usage!.useTokens} maxTokens={usage!.maxTokens} promptTokens={usage!.promptTokens} cacheReadTokens={usage!.cacheReadTokens} />}
            {processing ? (
              <button onClick={() => interrupt(sessionId!).catch(e => toast(e.message, 'error'))} title={t('chat.stop')}
                className="h-8 w-8 rounded-full bg-primary hover:bg-black text-white flex items-center justify-center"><Square size={12} fill="currentColor" /></button>
            ) : (
              <button onClick={() => doSend()} disabled={disabled || sending || (!draft.text.trim() && !draft.images.length && !draft.pastes.length)} title={t('chat.send')}
                className="h-8 w-8 rounded-full flex items-center justify-center transition-colors bg-primary hover:bg-black text-white disabled:bg-black/[0.08] disabled:text-muted/60 disabled:cursor-default"><ArrowUp size={16} strokeWidth={2.25} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 上下文用量：圆环 + 百分比（对齐插件 TokenProgress）；低占用只显圆环，hover 才显示数字 */
function TokenProgress({ useTokens, maxTokens, promptTokens, cacheReadTokens }: { useTokens: number; maxTokens: number; promptTokens: number; cacheReadTokens?: number }) {
  const pct = maxTokens > 0 ? Math.min((useTokens / maxTokens) * 100, 100) : 0;
  const fmt = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const low = pct < 50;
  const ring = pct > 85 ? 'stroke-danger' : pct > 60 ? 'stroke-warn' : 'stroke-fg/70';
  const text = pct > 85 ? 'text-danger' : 'text-muted';
  // 服务商返回了缓存命中数才显示命中行；旧历史无该字段时不显示
  const title = t('chat.usageTitle', { used: fmt(useTokens), max: fmt(maxTokens) })
    + (cacheReadTokens !== undefined ? `\n${t('chat.cacheHit')} ${fmt(cacheReadTokens)} / ${fmt(promptTokens)}` : '');
  return (
    <div className="group flex items-center gap-1 h-7 px-1.5 mr-1.5 rounded-md select-none hover:bg-black/[0.04]" title={title}>
      <span className={cn('text-[11px] tabular-nums tracking-wide', text, low && 'hidden group-hover:inline')}>{pct.toFixed(1)}%</span>
      <svg viewBox="0 0 36 36" className="w-3.5 h-3.5 -rotate-90 shrink-0">
        <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" className="stroke-black/10" />
        <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" strokeLinecap="round" className={cn('transition-[stroke-dasharray] duration-300', ring)} strokeDasharray={`${pct * 0.974}, 100`} />
      </svg>
    </div>
  );
}

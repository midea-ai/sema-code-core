import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, RefreshCw, Check, X, Eye, EyeOff } from 'lucide-react';
import { IconSelect } from '../../common/IconSelect';
import { useApp } from '../../store/app';
import { wsClient } from '../../api/ws';
import { api } from '../../api/http';
import { Button, Modal, Toggle, Spinner, Dropdown, cn, useDialog } from '../../common/ui';
import ProviderLogo, { parseProviderKey, stripProviderSuffix } from '../../common/ProviderLogo';
import { LanguageSelect } from '../../common/LanguageSelect';
import { t, languageLabel, type I18nKey } from '../../i18n';
import { collapsedHeaderPad } from '../../common/desktop';
import { PROVIDERS, PROVIDER_ORDER, DEFAULT_PROVIDER, DEFAULT_MAX_TOKENS, DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_TOKENS_OPTIONS, DEFAULT_CONTEXT_LENGTH_OPTIONS, formatTokenCount, validateCustomProviderName, providerLabel, apiKeyPlaceholder, parseProfileName, AdapterType, ThinkingHistoryPolicy } from './providers';
import { IMAGE_PROVIDERS, IMAGE_PROVIDER_ORDER, DEFAULT_IMAGE_PROVIDER, imageProviderLabel, validateImageProviderName, isTextToImageModel, type ImageListModel } from './imageProviders';
import { PERMISSION_LEVELS, DEFAULT_SYSTEM_PROMPT } from '../../../../shared/types';
import { defaultCustomRules } from '../../../../shared/lang';
import type { WebUISettings, BrowserControlState } from '../../../../shared/types';

/** Chrome 扩展商店页（Sema Browser Control） */
const CHROME_EXTENSION_STORE_URL = 'https://chromewebstore.google.com/detail/pjofgjgagohldpbcnkgnfjeehealejie';

export function SettingsPage({ tab, addModel }: { tab: 'models' | 'system'; addModel?: boolean }) {
  const setView = useApp(s => s.setView);
  const sidebarCollapsed = useApp(s => s.sidebarCollapsed);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className={cn('app-drag h-11 shrink-0 flex items-center gap-2 px-4 pt-px border-b border-border', sidebarCollapsed && collapsedHeaderPad)}>
        <TabBtn active={tab === 'system'} onClick={() => setView({ type: 'settings', tab: 'system' })}>{t('settings.system')}</TabBtn>
        <TabBtn active={tab === 'models'} onClick={() => setView({ type: 'settings', tab: 'models' })}>{t('settings.models')}</TabBtn>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6">
          {tab === 'models' ? <ModelsSettings autoAdd={addModel} /> : <SystemSettings />}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cn('h-7 px-2.5 rounded-md text-sm', active ? 'bg-black/[0.07] text-fg' : 'text-muted hover:text-fg hover:bg-black/[0.05]')}>{children}</button>;
}

// ==================== 模型配置 ====================

/** core 落盘的单个模型完整配置（与 sema-core ModelProfile 同形），编辑时由 core.getModelProfile 回填表单 */
interface ModelProfile {
  name: string;
  provider: string;
  modelName: string;
  baseURL?: string;
  apiKey: string;
  maxTokens: number;
  contextLength: number;
  adapt: AdapterType;
  thinkingHistoryPolicy?: ThinkingHistoryPolicy;
}

/** core 落盘的单个图像模型配置（与 sema-core ImageModelProfile 同形），编辑时由 core.getImageModelProfile 回填表单 */
interface ImageModelProfile {
  name: string;
  provider: string;
  modelName: string;
  baseURL: string;
  apiKey: string;
}

/** autoAdd：挂载时直接打开「添加模型」弹窗，只在挂载那一刻生效，关掉后不会再自动弹出 */
function ModelsSettings({ autoAdd }: { autoAdd?: boolean }) {
  const modelData = useApp(s => s.modelData);
  const refresh = useApp(s => s.refreshModelData);
  const toast = useApp(s => s.toast);
  const dialog = useDialog();
  // 弹窗状态：关闭 / 新增 / 编辑某条 profile
  const [dialogState, setDialogState] = useState<{ open: false } | { open: true; edit: ModelProfile | null }>(autoAdd ? { open: true, edit: null } : { open: false });
  const [imageDialog, setImageDialog] = useState<{ open: false } | { open: true; edit: ImageModelProfile | null }>({ open: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => { refresh().catch(() => undefined); }, [refresh]);

  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    try { await fn(); await refresh(); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const list = modelData?.modelList || [];
  const main = modelData?.taskConfig?.main || '';
  const quick = modelData?.taskConfig?.quick || '';
  const taskOf = (name: string) => name === main ? 'main' : name === quick ? 'quick' : '';
  const sorted = [...list].sort((a, b) => ({ main: 0, quick: 1, '': 2 }[taskOf(a)] - { main: 0, quick: 1, '': 2 }[taskOf(b)]));
  const applyTask = (cfg: { main: string; quick: string }) => run(() => wsClient.request('core.applyTaskModel', undefined, { config: cfg }));
  // 编辑：按 provider（保留原始大小写，parseProviderKey 会转小写）+ modelName 读完整落盘配置后打开弹窗回填
  const edit = async (fullName: string) => {
    const { provider, modelName } = parseProfileName(fullName);
    setBusy(true);
    try {
      const profile = await wsClient.request<ModelProfile | null>('core.getModelProfile', undefined, { provider, modelName });
      if (!profile) throw new Error(t('settings.fetchModelsFailed'));
      setDialogState({ open: true, edit: profile });
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const closeDialog = () => setDialogState({ open: false });

  const imageList = modelData?.imageModelList || [];
  const imageActive = modelData?.taskConfig?.image || '';
  const editImage = async (fullName: string) => {
    const { provider, modelName } = parseProfileName(fullName);
    setBusy(true);
    try {
      const profile = await wsClient.request<ImageModelProfile | null>('core.getImageModelProfile', undefined, { provider, modelName });
      if (!profile) throw new Error(t('settings.fetchModelsFailed'));
      setImageDialog({ open: true, edit: profile });
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const closeImageDialog = () => setImageDialog({ open: false });

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">{t('settings.modelList')}</h2>
          <Button variant="primary" size="sm" onClick={() => setDialogState({ open: true, edit: null })}><Plus size={14} />{t('settings.addModel')}</Button>
        </div>
        {!modelData && <div className="text-muted text-sm flex items-center gap-2"><Spinner />{t('common.loading')}</div>}
        {modelData && list.length === 0 && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm">{t('settings.noModelsYet')}</div>
        )}
        {list.length > 0 && (
          <div className="rounded-lg border border-border bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-panel text-muted text-xs">
                <tr>
                  <th className="text-left font-medium px-4 py-2 w-[32%]">{t('settings.provider.col')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('settings.model.col')}</th>
                  <th className="text-right font-medium px-4 py-2 w-20">{t('settings.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map(name => {
                  const provider = parseProviderKey(name);
                  const task = taskOf(name);
                  return (
                    <tr key={name} className="hover:bg-black/[0.02]">
                      <td className="px-4 py-2.5"><span className="inline-flex items-center gap-2"><ProviderLogo provider={provider} />{provider === 'custom' ? provider : providerLabel(provider)}</span></td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-2">
                          <span className="font-mono text-[13px]">{stripProviderSuffix(name)}</span>
                          {task === 'main' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{t('settings.mainModel')}</span>}
                          {task === 'quick' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-ok/10 text-ok">{t('settings.quickModel')}</span>}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button disabled={busy} title={t('settings.edit')} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06]" onClick={() => edit(name)}><Pencil size={14} /></button>
                          <button disabled={busy} title={t('settings.delete')} className="p-1 rounded text-muted hover:text-danger hover:bg-danger/10" onClick={async () => {
                            if (await dialog.confirm({ title: t('settings.delete'), message: t('settings.confirmDeleteModel', { name }), danger: true })) run(() => wsClient.request('core.delModel', undefined, { modelName: name }));
                          }}><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 各行按对应列表是否有模型决定显示：图像模型与对话模型各自独立，只配了图像模型时也要能选 */}
      {(list.length > 0 || imageList.length > 0) && (
        <section>
          <h2 className="text-base font-semibold mb-3">{t('settings.taskConfig')}</h2>
          <div className="rounded-lg border border-border bg-white py-1">
            {list.length > 0 && <TaskRow label={t('settings.mainModel')} desc={t('settings.mainDesc')} value={main} list={list} disabled={busy} onChange={v => applyTask({ main: v, quick: quick || v })} />}
            {list.length > 0 && <TaskRow label={t('settings.quickModel')} desc={t('settings.quickDesc')} value={quick} list={list} disabled={busy} onChange={v => applyTask({ main: main || v, quick: v })} />}
            {imageList.length > 0 && <TaskRow label={t('settings.imageModel')} desc={t('settings.imageActiveDesc')} value={imageActive} list={imageList} disabled={busy} emptyLabel={t('settings.imageOff')}
              onChange={v => run(() => wsClient.request('core.switchImageModel', undefined, { modelName: v }))} />}
          </div>
        </section>
      )}

      {/* 图像模型与对话模型各自独立：没有对话模型时也能配置 */}
      <section>
        <div className={cn('flex items-center justify-between', imageList.length > 0 ? 'mb-3' : 'mb-1')}>
          <h2 className="text-base font-semibold">{t('settings.imageModels')}</h2>
          {/* 图像模型是可选项：按钮用描边样式，避免和「添加模型」同样显眼被误认为必填 */}
          <Button size="sm" onClick={() => setImageDialog({ open: true, edit: null })}><Plus size={14} />{t('settings.addImageModel')}</Button>
        </div>
        {/* 说明只在还没有图像模型时显示；等 modelData 加载完再判断，避免已有模型时先闪一下 */}
        {modelData && imageList.length === 0 && <div className="text-xs text-muted">{t('settings.imageModelsDesc')}</div>}
        {imageList.length > 0 && (
          <div className="rounded-lg border border-border bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-panel text-muted text-xs">
                <tr>
                  <th className="text-left font-medium px-4 py-2 w-[32%]">{t('settings.provider.col')}</th>
                  <th className="text-left font-medium px-4 py-2">{t('settings.model.col')}</th>
                  <th className="text-right font-medium px-4 py-2 w-20">{t('settings.actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {imageList.map(name => {
                  const provider = parseProviderKey(name);
                  return (
                    <tr key={name} className="hover:bg-black/[0.02]">
                      <td className="px-4 py-2.5"><span className="inline-flex items-center gap-2"><ProviderLogo provider={provider} />{provider !== 'custom' && IMAGE_PROVIDERS[provider] ? imageProviderLabel(provider) : provider}</span></td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-2">
                          <span className="font-mono text-[13px]">{stripProviderSuffix(name)}</span>
                          {name === imageActive && <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{t('settings.imageInUse')}</span>}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button disabled={busy} title={t('settings.edit')} className="p-1 rounded text-muted hover:text-fg hover:bg-black/[0.06]" onClick={() => editImage(name)}><Pencil size={14} /></button>
                          <button disabled={busy} title={t('settings.delete')} className="p-1 rounded text-muted hover:text-danger hover:bg-danger/10" onClick={async () => {
                            if (await dialog.confirm({ title: t('settings.delete'), message: t('settings.confirmDeleteModel', { name }), danger: true })) run(() => wsClient.request('core.delImageModel', undefined, { modelName: name }));
                          }}><Trash2 size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AddModelDialog open={dialogState.open} editModel={dialogState.open ? dialogState.edit : null} onClose={closeDialog} onSaved={() => { closeDialog(); refresh().catch(() => undefined); }} />
      <AddImageModelDialog open={imageDialog.open} editModel={imageDialog.open ? imageDialog.edit : null} onClose={closeImageDialog} onSaved={() => { closeImageDialog(); refresh().catch(() => undefined); }} />
    </div>
  );
}

/** emptyLabel：传入时在选项最前加一个空值项（如图像模型的「不启用」） */
function TaskRow({ label, desc, value, list, disabled, onChange, emptyLabel }: { label: string; desc: string; value: string; list: string[]; disabled: boolean; onChange: (v: string) => void; emptyLabel?: string }) {
  const options = list.map(m => ({ value: m, label: stripProviderSuffix(m), icon: <ProviderLogo provider={parseProviderKey(m)} /> as React.ReactNode }));
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      {/* 标签与下拉框同高，垂直居中对齐下拉框而不是整行 */}
      <div className="w-28 shrink-0 h-9 flex items-center text-sm font-medium">{label}</div>
      <div className="flex-1 min-w-0">
        <Dropdown value={value} options={emptyLabel ? [{ value: '', label: emptyLabel }, ...options] : options}
          onChange={onChange} minWidth={260} tone="text-fg hover:bg-black/[0.05]"
          className={cn('w-full h-9 px-3 border border-border rounded-md bg-white justify-between', disabled && 'opacity-50 pointer-events-none')}
          // 字号写在内层：Dropdown 按钮自带 text-xs，在 className 里追加 text-sm 会被它盖掉
          renderValue={v => v ? <span className="inline-flex items-center gap-2 truncate text-sm"><ProviderLogo provider={parseProviderKey(v)} />{stripProviderSuffix(v)}</span> : <span className="text-sm text-muted">{emptyLabel || '—'}</span>} />
        <div className="mt-1.5 text-xs text-muted">{desc}</div>
      </div>
    </div>
  );
}

interface FetchedModel { id: string; name?: string; ownedBy?: string; key_doc_url?: string; recommended_max_tokens?: number; max_tokens?: number }

/** 新增模型表单草稿：关闭或保存弹窗时存下，下次新增时回填，方便同一服务商连续添加多个模型。含 API Key，只放内存不落 localStorage，刷新页面即清空 */
interface AddModelDraft {
  provider: string; customProviderName: string; baseURL: string; apiKey: string; adapt: AdapterType; thinkingHistoryPolicy: ThinkingHistoryPolicy;
  manual: boolean; modelName: string; selectedModel: string; models: FetchedModel[]; modelSource: 'remote' | 'preset' | 'none';
  maxTokens: string; modelMaxTokens: number | null; contextLength: string;
}
let addModelDraft: AddModelDraft | null = null;

/** 新增 / 编辑模型弹窗：editModel 非空为编辑态，锁定 provider 与模型名（改名等于新增一条），保存走 core.addModel 同名覆盖 */
function AddModelDialog({ open, editModel, onClose, onSaved }: { open: boolean; editModel: ModelProfile | null; onClose: () => void; onSaved: () => void }) {
  const toast = useApp(s => s.toast);
  const isEditing = !!editModel;
  const [provider, setProvider] = useState(DEFAULT_PROVIDER);
  const [customProviderName, setCustomProviderName] = useState('');  // 打开弹窗时由 onProvider 重置
  const [baseURL, setBaseURL] = useState(PROVIDERS[DEFAULT_PROVIDER].baseURL);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [adapt, setAdapt] = useState<AdapterType>(PROVIDERS[DEFAULT_PROVIDER].defaultAdapt || 'openai');
  const [thinkingHistoryPolicy, setThinkingHistoryPolicy] = useState<ThinkingHistoryPolicy>(PROVIDERS[DEFAULT_PROVIDER].defaultThinkingHistoryPolicy || 'preserve');
  const [manual, setManual] = useState(false);
  const [modelName, setModelName] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [modelSource, setModelSource] = useState<'remote' | 'preset' | 'none'>('none');  // 模型列表来源：core 从服务端获取 / 应用层内置列表 / 没有列表
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS));
  const [modelMaxTokens, setModelMaxTokens] = useState<number | null>(null);
  const [contextLength, setContextLength] = useState(String(DEFAULT_CONTEXT_LENGTH));
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [tested, setTested] = useState<'none' | 'ok' | 'fail'>('none');
  const apiKeyInput = useRef<HTMLInputElement>(null);

  const p = PROVIDERS[provider];
  const currentModel = manual ? modelName.trim() : selectedModel;
  const invalidate = () => { setTested('none'); };

  const onProvider = (k: string) => {
    const d = PROVIDERS[k];
    setProvider(k); setCustomProviderName(k === 'custom' ? 'custom' : ''); setBaseURL(d.baseURL); setApiKey(''); setModelName(''); setSelectedModel(''); setModels([]); setFetchFailed(false); setModelSource('none'); setManual(false);
    setMaxTokens(String(d.defaultMaxTokens ?? DEFAULT_MAX_TOKENS)); setModelMaxTokens(null); setContextLength(String(d.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH));
    setAdapt(d.defaultAdapt || 'openai'); setThinkingHistoryPolicy(d.defaultThinkingHistoryPolicy || 'preserve'); setStatus(null); invalidate();
  };
  useEffect(() => {
    if (!open) return;
    if (!editModel) {
      // 新增：服务商与地址有默认值，直接聚焦到 API Key
      apiKeyInput.current?.focus();
      // 有上次的草稿就回填，连接测试结果不沿用，保存前需重新测试
      const d = addModelDraft;
      if (!d) { onProvider(DEFAULT_PROVIDER); return; }
      setProvider(d.provider); setCustomProviderName(d.customProviderName); setBaseURL(d.baseURL); setApiKey(d.apiKey); setShowKey(false);
      setAdapt(d.adapt); setThinkingHistoryPolicy(d.thinkingHistoryPolicy);
      setManual(d.manual); setModelName(d.modelName); setSelectedModel(d.selectedModel); setModels(d.models); setFetchFailed(false); setModelSource(d.modelSource);
      setMaxTokens(d.maxTokens); setModelMaxTokens(d.modelMaxTokens); setContextLength(d.contextLength);
      setStatus(null); invalidate();
      return;
    }
    // 编辑：按落盘配置回填，模型名走手动输入分支（不依赖「获取模型」）
    const preset = !!PROVIDERS[editModel.provider] && editModel.provider !== 'custom';
    setProvider(preset ? editModel.provider : 'custom'); setCustomProviderName(preset ? '' : editModel.provider);
    setBaseURL(editModel.baseURL ?? ''); setApiKey(editModel.apiKey ?? ''); setShowKey(false);
    setAdapt(editModel.adapt ?? 'openai'); setThinkingHistoryPolicy(editModel.thinkingHistoryPolicy ?? 'preserve');
    setManual(true); setModelName(editModel.modelName); setSelectedModel(''); setModels([]); setFetchFailed(false); setModelSource('none');
    setMaxTokens(String(editModel.maxTokens)); setModelMaxTokens(null); setContextLength(String(editModel.contextLength));
    setStatus(null); invalidate();
  }, [open, editModel]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 编辑态只有连接相关字段相对回填值有改动才要求重新测试；只改 token 数不用重测 */
  const connectionChanged = !editModel || baseURL !== (editModel.baseURL ?? '') || apiKey !== (editModel.apiKey ?? '') || adapt !== (editModel.adapt ?? 'openai');

  /** 新增态离开弹窗（取消 / 关闭 / 保存成功）前存草稿；编辑态的回填值不进草稿 */
  const saveDraft = () => {
    if (isEditing) return;
    addModelDraft = { provider, customProviderName, baseURL, apiKey, adapt, thinkingHistoryPolicy, manual, modelName, selectedModel, models, modelSource, maxTokens, modelMaxTokens, contextLength };
  };
  const close = () => { saveDraft(); onClose(); };

  const applyModel = async (id: string) => {
    setSelectedModel(id); invalidate();
    const m = models.find(x => x.id === id);
    if (m?.recommended_max_tokens) setMaxTokens(String(m.recommended_max_tokens));
    setModelMaxTokens(m?.max_tokens ?? null);
    try { const ad = await wsClient.request<AdapterType | null>('core.getModelAdapter', undefined, { provider, modelName: id, baseURL }); if (ad) setAdapt(ad); } catch { /* ignore */ }
  };

  /** 把模型列表填入下拉并选中默认模型，remote 与 preset 两种来源共用 */
  const applyList = async (list: FetchedModel[], source: 'remote' | 'preset') => {
    setModels(list); setModelSource(source); setFetchFailed(false);
    const pick = (p.defaultModel && list.find(m => m.id === p.defaultModel)) ? p.defaultModel! : list[0].id;
    // 用刚拿到的列表应用默认模型（models state 尚未更新，直接读 list）
    setSelectedModel(pick); invalidate();
    const m = list.find(x => x.id === pick);
    if (m?.recommended_max_tokens) setMaxTokens(String(m.recommended_max_tokens));
    setModelMaxTokens(m?.max_tokens ?? null);
    try { const ad = await wsClient.request<AdapterType | null>('core.getModelAdapter', undefined, { provider, modelName: pick, baseURL }); if (ad) setAdapt(ad); } catch { /* ignore */ }
  };

  const fetchModels = async () => {
    if (!baseURL) { setStatus({ type: 'error', text: t('settings.err.baseURL') }); return; }
    if (p.requiresApiKeyForModelList !== false && !apiKey) { setStatus({ type: 'error', text: t('settings.err.apiKey') }); return; }
    // 没有列表接口但有内置列表的服务商，直接使用内置列表，不请求 core
    if (!p.modelsUrl && p.presetModels?.length) { setStatus(null); await applyList(p.presetModels, 'preset'); return; }
    setFetching(true); setStatus({ type: 'info', text: t('settings.fetchingModels') });
    try {
      const r = await wsClient.request<any>('core.fetchAvailableModels', undefined, { params: { provider, baseURL, apiKey, adapt, modelsUrl: p.modelsUrl } });
      if (!r?.success) throw new Error(r?.message || t('settings.fetchModelsFailed'));
      const list: FetchedModel[] = r.models || [];
      if (!list.length) throw new Error(t('settings.fetchModelsEmpty'));
      const okText = t('settings.fetchModelsOk', { n: list.length });
      setStatus({ type: 'ok', text: okText });
      setTimeout(() => setStatus(s => s?.text === okText ? null : s), 3000);
      await applyList(list, 'remote');
    } catch (e: any) {
      setStatus({ type: 'error', text: e.message });
      // 远端拿不到时用内置列表兜底，没有内置列表才算没有模型列表
      if (p.presetModels?.length) await applyList(p.presetModels, 'preset');
      else { setModelSource('none'); setFetchFailed(true); }
    } finally { setFetching(false); }
  };

  const testConn = async () => {
    if (!baseURL) { setStatus({ type: 'error', text: t('settings.err.baseURL') }); return; }
    if (!apiKey) { setStatus({ type: 'error', text: t('settings.err.apiKey') }); return; }
    if (!currentModel) { setStatus({ type: 'error', text: t('settings.err.needModel') }); return; }
    setTesting(true); setStatus({ type: 'info', text: t('settings.testingConn') });
    try {
      const r = await wsClient.request<any>('core.testApiConnection', undefined, { params: { provider, baseURL, apiKey, modelName: currentModel, adapt } });
      setTested(r?.success ? 'ok' : 'fail');
      setStatus({ type: r?.success ? 'ok' : 'error', text: r?.success ? t('settings.testOk') : `${t('settings.testFail')}：${r?.message || ''}` });
    } catch (e: any) { setTested('fail'); setStatus({ type: 'error', text: `${t('settings.testFail')}：${e.message}` }); } finally { setTesting(false); }
  };

  const save = async () => {
    if (!apiKey) { setStatus({ type: 'error', text: t('settings.err.apiKey') }); return; }
    if (!currentModel) { setStatus({ type: 'error', text: t('settings.err.needModel') }); return; }
    if (connectionChanged && tested === 'none') { setStatus({ type: 'error', text: t('settings.err.testFirst') }); return; }
    if (tested === 'fail') { setStatus({ type: 'error', text: t('settings.err.testFailed') }); return; }
    const aliasError = provider === 'custom' ? validateCustomProviderName(customProviderName) : null;
    if (aliasError) { setStatus({ type: 'error', text: t('settings.err.providerName', { error: aliasError }) }); return; }
    setSaving(true);
    try {
      await wsClient.request('core.addModel', undefined, { config: { provider: provider === 'custom' && customProviderName ? customProviderName : provider, modelName: currentModel, baseURL, apiKey, maxTokens: parseInt(maxTokens), contextLength: parseInt(contextLength), adapt, thinkingHistoryPolicy }, skipValidation: true });
      toast(t('settings.saved'));
      saveDraft();
      onSaved();
    } catch (e: any) { setStatus({ type: 'error', text: e.message }); } finally { setSaving(false); }
  };

  const docUrl = (selectedModel && models.find(m => m.id === selectedModel)?.key_doc_url) || p.apikeyUrl || '';
  const linkCls = 'text-xs text-accent hover:underline cursor-pointer';

  return (
    <Modal open={open} onClose={close} title={isEditing ? t('settings.editModel') : t('settings.addModel')} width={680}>
      <div className="flex flex-col gap-4 text-sm">
        <Field label={t('settings.provider')}>
          <IconSelect value={provider} onChange={onProvider} disabled={isEditing}
            options={PROVIDER_ORDER.filter(k => PROVIDERS[k]).map(k => ({ value: k, label: providerLabel(k), icon: <ProviderLogo provider={k} /> }))} />
        </Field>
        {provider === 'custom' && (
          <Field label={t('settings.providerName')}>
            <input value={customProviderName} disabled={isEditing} onChange={e => { setCustomProviderName(e.target.value.trim()); invalidate(); }}
              placeholder={t('settings.providerNamePlaceholder')}
              className="w-full h-9 px-3 rounded-md bg-white border border-border focus:border-accent disabled:opacity-60" />
            {validateCustomProviderName(customProviderName) && (
              <div className="text-xs text-danger">{validateCustomProviderName(customProviderName)}</div>
            )}
          </Field>
        )}
        <Field label={t('settings.baseURL')}>
          <input value={baseURL} onChange={e => { setBaseURL(e.target.value); invalidate(); }} placeholder={p.baseURLPlaceholder || p.baseURL} className="w-full h-9 px-3 rounded-md bg-white border border-border focus:border-accent" />
        </Field>
        <Field label={t('settings.apiKey')} hint={docUrl ? <a className={linkCls} href={docUrl} target="_blank" rel="noreferrer" title={docUrl}>{t('settings.getApiKey')}</a> : undefined}>
          <div className="relative">
            <input ref={apiKeyInput} type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => { setApiKey(e.target.value.trim()); invalidate(); }} placeholder={apiKeyPlaceholder(provider)} className="w-full h-9 pl-3 pr-9 rounded-md bg-white border border-border focus:border-accent" />
            <button type="button" onClick={() => setShowKey(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-fg" title={showKey ? t('settings.hideKey') : t('settings.showKey')}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
          </div>
        </Field>
        <Field label={t('settings.modelName')} hint={isEditing ? undefined : <span className={linkCls} onClick={() => { setManual(v => !v); invalidate(); }}>{manual ? t('settings.pickFromList') : t('settings.manualInput')}</span>}>
          {manual ? (
            <input value={modelName} disabled={isEditing} onChange={e => { setModelName(e.target.value); invalidate(); }} placeholder={p.defaultModel ? t('settings.modelNamePlaceholderEg', { model: p.defaultModel }) : t('settings.modelNamePlaceholder')} className="w-full h-9 px-3 rounded-md bg-white border border-border focus:border-accent disabled:opacity-60" />
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-2 items-center">
                <div className="flex-1 min-w-0">
                  <IconSelect value={selectedModel} onChange={applyModel} disabled={models.length === 0} placeholder={t('settings.fetchModelsFirst')}
                    options={models.map(m => ({ value: m.id, label: m.name || m.id }))} />
                </div>
                <Button onClick={fetchModels} disabled={fetching} className="h-9">{fetching ? <Spinner /> : <RefreshCw size={13} />}{fetching ? t('settings.fetching') : t('settings.fetchModels')}</Button>
              </div>
              {fetchFailed && models.length === 0 && (
                <div className="text-xs text-muted">{t('settings.fetchModelsHint')} <span className={linkCls} onClick={() => setManual(true)}>{t('settings.manualModelName')}</span></div>
              )}
            </div>
          )}
        </Field>
        <Field label={t('settings.adapt')}>
          <IconSelect value={adapt} onChange={v => setAdapt(v as AdapterType)} options={[{ value: 'openai', label: t('settings.adapt.openai') }, { value: 'anthropic', label: t('settings.adapt.anthropic') }]} />
        </Field>
        <Field label={t('settings.thinkingHistoryPolicy')}>
          <IconSelect value={thinkingHistoryPolicy} onChange={v => setThinkingHistoryPolicy(v as ThinkingHistoryPolicy)}
            options={[
              { value: 'preserve', label: t('settings.thinkingHistoryPolicy.preserve') },
              { value: 'current_turn', label: t('settings.thinkingHistoryPolicy.currentTurn') },
              { value: 'omit', label: t('settings.thinkingHistoryPolicy.omit') },
            ]} />
          {thinkingHistoryPolicy !== 'preserve' && thinkingHistoryPolicy !== p.defaultThinkingHistoryPolicy && (
            <div className="text-xs text-warn">{t('settings.thinkingHistoryPolicy.warn')}</div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('settings.maxTokens')}>
            <IconSelect value={maxTokens} onChange={setMaxTokens}
              options={(p.maxTokensOptions ?? DEFAULT_MAX_TOKENS_OPTIONS).map(v => ({ value: String(v), label: formatTokenCount(v), disabled: modelMaxTokens !== null && v > modelMaxTokens }))} />
          </Field>
          <Field label={t('settings.contextLength')}>
            <IconSelect value={contextLength} onChange={setContextLength}
              options={(p.contextLengthOptions ?? DEFAULT_CONTEXT_LENGTH_OPTIONS).map(v => ({ value: String(v), label: formatTokenCount(v) }))} />
          </Field>
        </div>
        {status && (
          <div className={cn('rounded-md px-3 py-2 text-xs flex items-start gap-2 max-h-40 overflow-auto',
            status.type === 'ok' ? 'bg-ok/10 text-ok' : status.type === 'error' ? 'bg-danger/10 text-danger' : 'bg-panel text-muted')}>
            {status.type === 'ok' ? <Check size={14} className="shrink-0" /> : status.type === 'error' ? <X size={14} className="shrink-0" /> : <Spinner className="shrink-0" />}
            <span className="whitespace-pre-wrap break-all">{status.text}</span>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-1">
          <Button variant="ghost" onClick={close}>{t('dialog.cancel')}</Button>
          <Button onClick={testConn} disabled={testing}>{testing ? <Spinner /> : null}{testing ? t('settings.testing') : t('settings.test')}</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? <Spinner /> : null}{saving ? (isEditing ? t('settings.saving') : t('settings.adding')) : (isEditing ? t('settings.saveChanges') : t('settings.addModel'))}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** 新增图像模型表单草稿：与 AddModelDraft 同样只放内存，关闭或保存弹窗时存下，下次新增时回填 */
interface AddImageModelDraft {
  provider: string; customProviderName: string; baseURL: string; apiKey: string;
  manual: boolean; modelName: string; selectedModel: string; models: ImageListModel[]; modelSource: 'remote' | 'preset' | 'none';
}
let addImageModelDraft: AddImageModelDraft | null = null;

/** 新增 / 编辑图像模型弹窗：编辑态锁定 provider 与模型名，保存走 core.addImageModel 同名覆盖；core 不提供图像模型的测试连接（测一次要真实出图） */
function AddImageModelDialog({ open, editModel, onClose, onSaved }: { open: boolean; editModel: ImageModelProfile | null; onClose: () => void; onSaved: () => void }) {
  const toast = useApp(s => s.toast);
  const isEditing = !!editModel;
  const [provider, setProvider] = useState(DEFAULT_IMAGE_PROVIDER);
  const [customProviderName, setCustomProviderName] = useState('');
  const [baseURL, setBaseURL] = useState(IMAGE_PROVIDERS[DEFAULT_IMAGE_PROVIDER].baseURL);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [manual, setManual] = useState(false);
  const [modelName, setModelName] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [models, setModels] = useState<ImageListModel[]>([]);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [modelSource, setModelSource] = useState<'remote' | 'preset' | 'none'>('none');  // 模型列表来源：core 从服务端获取 / 应用层内置列表 / 没有列表
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const apiKeyInput = useRef<HTMLInputElement>(null);

  const p = IMAGE_PROVIDERS[provider];
  /** 有列表接口或内置列表的服务商才提供下拉选择；自定义接口只能手动输入 */
  const hasList = !!(p.modelsUrl || p.presetModels?.length);
  const pickFromList = hasList && !manual;
  const currentModel = pickFromList ? selectedModel : modelName.trim();

  const resetModels = () => { setModelName(''); setSelectedModel(''); setModels([]); setFetchFailed(false); setModelSource('none'); };
  const onProvider = (k: string) => {
    setProvider(k); setCustomProviderName(k === 'custom' ? 'custom' : ''); setBaseURL(IMAGE_PROVIDERS[k].baseURL); setApiKey(''); setShowKey(false);
    resetModels(); setManual(false); setStatus(null);
  };
  useEffect(() => {
    if (!open) return;
    if (!editModel) {
      // 新增：服务商与地址有默认值，直接聚焦到 API Key
      apiKeyInput.current?.focus();
      // 有上次的草稿就回填
      const d = addImageModelDraft;
      if (!d) { onProvider(DEFAULT_IMAGE_PROVIDER); return; }
      setProvider(d.provider); setCustomProviderName(d.customProviderName); setBaseURL(d.baseURL); setApiKey(d.apiKey); setShowKey(false);
      setManual(d.manual); setModelName(d.modelName); setSelectedModel(d.selectedModel); setModels(d.models); setFetchFailed(false); setModelSource(d.modelSource);
      setStatus(null);
      return;
    }
    // 编辑：按落盘配置回填，模型名走手动输入分支（不依赖「获取模型」）
    const preset = !!IMAGE_PROVIDERS[editModel.provider] && editModel.provider !== 'custom';
    setProvider(preset ? editModel.provider : 'custom'); setCustomProviderName(preset ? '' : editModel.provider);
    setBaseURL(editModel.baseURL ?? ''); setApiKey(editModel.apiKey ?? ''); setShowKey(false);
    resetModels(); setManual(true); setModelName(editModel.modelName); setStatus(null);
  }, [open, editModel]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 把模型列表填入下拉并选中默认模型，remote 与 preset 两种来源共用 */
  const applyList = (list: ImageListModel[], source: 'remote' | 'preset') => {
    setModels(list); setModelSource(source); setFetchFailed(false);
    setSelectedModel((p.defaultModel && list.find(m => m.id === p.defaultModel)) ? p.defaultModel! : list[0].id);
  };

  const fetchModels = async () => {
    // 没有列表接口但有内置列表的服务商，直接使用内置列表，不请求 core
    if (!p.modelsUrl && p.presetModels?.length) { setStatus(null); applyList(p.presetModels, 'preset'); return; }
    if (p.requiresApiKeyForModelList !== false && !apiKey) { setStatus({ type: 'error', text: t('settings.err.apiKey') }); return; }
    setFetching(true); setStatus({ type: 'info', text: t('settings.fetchingModels') });
    try {
      const r = await wsClient.request<any>('core.fetchAvailableModels', undefined, { params: { provider, baseURL, apiKey, adapt: 'openai', modelsUrl: p.modelsUrl } });
      if (!r?.success) throw new Error(r?.message || t('settings.fetchModelsFailed'));
      const list = ((r.models || []) as ImageListModel[]).filter(isTextToImageModel);
      if (!list.length) throw new Error(t('settings.fetchModelsEmpty'));
      const okText = t('settings.fetchModelsOk', { n: list.length });
      setStatus({ type: 'ok', text: okText });
      setTimeout(() => setStatus(s => s?.text === okText ? null : s), 3000);
      applyList(list, 'remote');
    } catch (e: any) {
      setStatus({ type: 'error', text: e.message });
      // 远端拿不到时用内置列表兜底，没有内置列表才算没有模型列表
      if (p.presetModels?.length) applyList(p.presetModels, 'preset');
      else { setModelSource('none'); setFetchFailed(true); }
    } finally { setFetching(false); }
  };

  // 编辑态别名已锁定且是落盘值，不再校验
  const aliasError = provider === 'custom' && !isEditing ? validateImageProviderName(customProviderName) : null;
  const canSave = !!baseURL.trim() && !!apiKey && !!currentModel && !aliasError;

  /** 新增态离开弹窗（取消 / 关闭 / 保存成功）前存草稿；编辑态的回填值不进草稿 */
  const saveDraft = () => {
    if (isEditing) return;
    addImageModelDraft = { provider, customProviderName, baseURL, apiKey, manual, modelName, selectedModel, models, modelSource };
  };
  const close = () => { saveDraft(); onClose(); };

  const save = async () => {
    setSaving(true); setStatus(null);
    try {
      await wsClient.request('core.addImageModel', undefined, { config: { provider: provider === 'custom' && customProviderName ? customProviderName : provider, modelName: currentModel, baseURL: baseURL.trim(), apiKey } });
      toast(t('settings.saved'));
      saveDraft();
      onSaved();
    } catch (e: any) { setStatus({ type: 'error', text: e.message }); } finally { setSaving(false); }
  };

  const linkCls = 'text-xs text-accent hover:underline cursor-pointer';
  const inputCls = 'w-full h-9 px-3 rounded-md bg-white border border-border focus:border-accent disabled:opacity-60';
  return (
    <Modal open={open} onClose={close} title={isEditing ? t('settings.editImageModel') : t('settings.addImageModel')} width={680}>
      <div className="flex flex-col gap-4 text-sm">
        <Field label={t('settings.provider')}>
          <IconSelect value={provider} onChange={onProvider} disabled={isEditing}
            options={IMAGE_PROVIDER_ORDER.map(k => ({ value: k, label: imageProviderLabel(k), icon: <ProviderLogo provider={k} /> }))} />
        </Field>
        {provider === 'custom' && (
          <Field label={t('settings.providerName')}>
            <input value={customProviderName} disabled={isEditing} onChange={e => setCustomProviderName(e.target.value.trim())} placeholder={t('settings.providerNamePlaceholder')} className={inputCls} />
            {aliasError && <div className="text-xs text-danger">{aliasError}</div>}
          </Field>
        )}
        <Field label={t('settings.baseURL')}>
          <input value={baseURL} onChange={e => setBaseURL(e.target.value)} placeholder={p.baseURLPlaceholder || p.baseURL} className={inputCls} />
        </Field>
        <Field label={t('settings.apiKey')} hint={p.apikeyUrl ? <a className={linkCls} href={p.apikeyUrl} target="_blank" rel="noreferrer" title={p.apikeyUrl}>{t('settings.getApiKey')}</a> : undefined}>
          <div className="relative">
            <input ref={apiKeyInput} type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => setApiKey(e.target.value.trim())} placeholder={t('settings.apiKeyPlaceholderGeneric')} className="w-full h-9 pl-3 pr-9 rounded-md bg-white border border-border focus:border-accent" />
            <button type="button" onClick={() => setShowKey(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-fg" title={showKey ? t('settings.hideKey') : t('settings.showKey')}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
          </div>
        </Field>
        <Field label={t('settings.modelName')} hint={isEditing || !hasList ? undefined : <span className={linkCls} onClick={() => setManual(v => !v)}>{manual ? t('settings.pickFromList') : t('settings.manualInput')}</span>}>
          {!pickFromList ? (
            <input value={modelName} disabled={isEditing} onChange={e => setModelName(e.target.value)} placeholder={p.defaultModel ? t('settings.modelNamePlaceholderEg', { model: p.defaultModel }) : t('settings.modelNamePlaceholder')} className={inputCls} />
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-2 items-center">
                <div className="flex-1 min-w-0">
                  <IconSelect value={selectedModel} onChange={setSelectedModel} disabled={models.length === 0} placeholder={t('settings.fetchModelsFirst')}
                    options={models.map(m => ({ value: m.id, label: m.name || m.id }))} />
                </div>
                <Button onClick={fetchModels} disabled={fetching} className="h-9">{fetching ? <Spinner /> : <RefreshCw size={13} />}{fetching ? t('settings.fetching') : t('settings.fetchModels')}</Button>
              </div>
              {fetchFailed && models.length === 0 && (
                <div className="text-xs text-muted">{t('settings.fetchModelsHint')} <span className={linkCls} onClick={() => setManual(true)}>{t('settings.manualModelName')}</span></div>
              )}
            </div>
          )}
        </Field>
        {status && (
          <div className={cn('rounded-md px-3 py-2 text-xs flex items-start gap-2 max-h-40 overflow-auto',
            status.type === 'ok' ? 'bg-ok/10 text-ok' : status.type === 'error' ? 'bg-danger/10 text-danger' : 'bg-panel text-muted')}>
            {status.type === 'ok' ? <Check size={14} className="shrink-0" /> : status.type === 'error' ? <X size={14} className="shrink-0" /> : <Spinner className="shrink-0" />}
            <span className="whitespace-pre-wrap break-all">{status.text}</span>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-1">
          <Button variant="ghost" onClick={close}>{t('dialog.cancel')}</Button>
          <Button variant="primary" onClick={save} disabled={saving || !canSave}>{saving ? <Spinner /> : null}{saving ? (isEditing ? t('settings.saving') : t('settings.adding')) : (isEditing ? t('settings.saveChanges') : t('settings.addImageModel'))}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted flex items-center justify-between">{label}{hint}</span>
      {children}
    </label>
  );
}

// ==================== 系统配置 ====================

type CoreBoolKey = 'skipFileEditPermission' | 'skipShellExecPermission' | 'skipSkillPermission' | 'skipMCPToolPermission' | 'skipFetchUrlPermission' | 'skipExternalFileReadPermission' | 'disableBackgroundTasks' | 'enableToolSearch' | 'enableInputPrediction';
// 存 key、渲染时取文案：模块顶层调 t() 切换语言后不会更新
const BASIC_KEYS: Array<{ key: CoreBoolKey; label: I18nKey }> = [
  { key: 'enableToolSearch', label: 'settings.enableToolSearch' },
  { key: 'enableInputPrediction', label: 'settings.enableInputPrediction' },
  { key: 'disableBackgroundTasks', label: 'settings.disableBg' },
];
const PERMISSION_KEYS: Array<{ key: CoreBoolKey; label: I18nKey }> = [
  { key: 'skipFileEditPermission', label: 'settings.skipFileEdit' },
  { key: 'skipShellExecPermission', label: 'settings.skipShell' },
  { key: 'skipSkillPermission', label: 'settings.skipSkill' },
  { key: 'skipMCPToolPermission', label: 'settings.skipMCP' },
  { key: 'skipFetchUrlPermission', label: 'settings.skipFetch' },
  { key: 'skipExternalFileReadPermission', label: 'settings.skipExternalRead' },
];

function SystemSettings() {
  const settings = useApp(s => s.settings);
  const save = useApp(s => s.saveSettings);
  const toast = useApp(s => s.toast);
  const [rules, setRules] = useState(settings?.coreConfig.customRules || '');
  const [savingRules, setSavingRules] = useState(false);
  useEffect(() => { setRules(settings?.coreConfig.customRules || ''); }, [settings?.coreConfig.customRules]);
  const [rolePrompt, setRolePrompt] = useState(settings?.coreConfig.systemPrompt || '');
  const [savingRole, setSavingRole] = useState(false);
  useEffect(() => { setRolePrompt(settings?.coreConfig.systemPrompt || ''); }, [settings?.coreConfig.systemPrompt]);
  if (!settings) return null;

  const patch = async (p: Partial<WebUISettings>) => { try { await save(p); } catch (e: any) { toast(e.message, 'error'); } };
  const defaultRules = defaultCustomRules(settings.coreConfig.lang);
  const ToggleRow = ({ k, label }: { k: CoreBoolKey; label: I18nKey }) => (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm">
      <span>{t(label)}</span>
      <Toggle checked={!!settings.coreConfig[k]} onChange={v => patch({ coreConfig: { ...settings.coreConfig, [k]: v } })} />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-base font-semibold mb-3">{t('settings.basic')}</h2>
        <div className="rounded-lg border border-border bg-white divide-y divide-border">
          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span>{languageLabel()}</span>
            <div className="w-40"><LanguageSelect /></div>
          </div>
          {BASIC_KEYS.map(({ key, label }) => <ToggleRow key={key} k={key} label={label} />)}
        </div>
      </section>
      <section>
        <h2 className="text-base font-semibold mb-3">{t('settings.integrations')}</h2>
        <div className="rounded-lg border border-border bg-white divide-y divide-border">
          <BrowserControlRow />
        </div>
      </section>
      <section>
        <h2 className="text-base font-semibold mb-3">{t('settings.rolePrompt')}</h2>
        <input value={rolePrompt} onChange={e => setRolePrompt(e.target.value)} placeholder={DEFAULT_SYSTEM_PROMPT} className="w-full h-9 px-3 rounded-md bg-white border border-border text-sm font-mono" />
        <div className="flex justify-end gap-2 mt-2">
          <Button variant="ghost" size="sm" disabled={savingRole || (rolePrompt === DEFAULT_SYSTEM_PROMPT && settings.coreConfig.systemPrompt === DEFAULT_SYSTEM_PROMPT)}
            onClick={async () => { setRolePrompt(DEFAULT_SYSTEM_PROMPT); if (settings.coreConfig.systemPrompt !== DEFAULT_SYSTEM_PROMPT) { setSavingRole(true); await patch({ coreConfig: { ...settings.coreConfig, systemPrompt: DEFAULT_SYSTEM_PROMPT } }); setSavingRole(false); toast(t('settings.saved')); } }}>{t('settings.resetDefault')}</Button>
          <Button variant="primary" size="sm" disabled={savingRole || rolePrompt === settings.coreConfig.systemPrompt}
            onClick={async () => { setSavingRole(true); await patch({ coreConfig: { ...settings.coreConfig, systemPrompt: rolePrompt } }); setSavingRole(false); toast(t('settings.saved')); }}>{t('settings.save')}</Button>
        </div>
      </section>
      <section>
        <h2 className="text-base font-semibold mb-3">{t('settings.customRules')}</h2>
        <textarea value={rules} onChange={e => setRules(e.target.value)} rows={5} className="w-full p-3 rounded-md bg-white border border-border text-sm font-mono resize-y" />
        <div className="flex justify-end gap-2 mt-2">
          {/* 恢复为当前界面语言的默认规则 */}
          <Button variant="ghost" size="sm" disabled={savingRules || (rules === defaultRules && settings.coreConfig.customRules === defaultRules)}
            onClick={async () => { setRules(defaultRules); if (settings.coreConfig.customRules !== defaultRules) { setSavingRules(true); await patch({ coreConfig: { ...settings.coreConfig, customRules: defaultRules } }); setSavingRules(false); toast(t('settings.saved')); } }}>{t('settings.resetDefault')}</Button>
          <Button variant="primary" size="sm" disabled={savingRules || rules === settings.coreConfig.customRules}
            onClick={async () => { setSavingRules(true); await patch({ coreConfig: { ...settings.coreConfig, customRules: rules } }); setSavingRules(false); toast(t('settings.saved')); }}>{t('settings.save')}</Button>
        </div>
      </section>
      <section>
        <h2 className="text-base font-semibold mb-1">{t('settings.permissions')}</h2>
        <p className="text-xs text-muted mb-3">{t('settings.permissionsDesc')}</p>
        <div className="rounded-lg border border-border bg-white divide-y divide-border">
          <div className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span>{t('settings.defaultLevel')}</span>
            <div className="w-40"><IconSelect value={settings.defaultPermissionLevel} onChange={v => patch({ defaultPermissionLevel: v as any })} options={PERMISSION_LEVELS.map(l => ({ value: l, label: l }))} /></div>
          </div>
          {PERMISSION_KEYS.map(({ key, label }) => <ToggleRow key={key} k={key} label={label} />)}
        </div>
      </section>
    </div>
  );
}

/**
 * 浏览器控制开关（对齐 IDE 插件 SystemConfig 的同名区块）：不走 saveSettings，而是 POST /api/browser-control 执行装/删动作，
 * 配置键由服务端在动作成功后写入；执行中禁用开关等结果，失败 toast 并回到原值。win32 禁用，linux 标实验性。
 */
function BrowserControlRow() {
  const platform = useApp(s => s.platform);
  const toast = useApp(s => s.toast);
  const openExternal = useApp(s => s.openExternal);
  const [state, setState] = useState<BrowserControlState | null>(null);
  const [busy, setBusy] = useState<false | 'enabling' | 'disabling'>(false);
  useEffect(() => { api<BrowserControlState>('GET', '/api/browser-control').then(setState).catch(() => undefined); }, []);

  const supported = state ? state.supported : platform !== 'win32';
  const enabled = !!state?.enabled && supported;
  const change = async (v: boolean) => {
    if (busy || !supported) return;
    setBusy(v ? 'enabling' : 'disabling');
    try { setState(await api<BrowserControlState>('POST', '/api/browser-control', { enabled: v })); }
    catch (e: any) { toast(t('settings.browserControlFailed', { error: e.message }), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="px-4 py-2.5 text-sm">
      <div className="flex items-center justify-between" title={t('settings.browserControlTip')}>
        <span className={cn(!supported && 'text-muted')}>
          {t('settings.browserControl')}
          {!supported && t('settings.browserControlUnsupportedSuffix')}
          {supported && platform === 'linux' && t('settings.browserControlExperimentalSuffix')}
        </span>
        <div className="flex items-center gap-2">
          {busy && <Spinner />}
          <Toggle checked={enabled} disabled={!supported || !!busy} onChange={change} />
        </div>
      </div>
      {busy && <div className="mt-1 text-xs text-muted">{busy === 'enabling' ? t('settings.browserControlEnabling') : t('settings.browserControlDisabling')}</div>}
      {!busy && enabled && (
        <div className="mt-1 text-xs text-muted">
          {t('settings.browserControlInstallPrefix')}
          <a href={CHROME_EXTENSION_STORE_URL} className="text-accent hover:underline" onClick={e => { e.preventDefault(); openExternal(CHROME_EXTENSION_STORE_URL).catch(() => undefined); }}>{t('settings.browserControlInstallLink')}</a>
        </div>
      )}
    </div>
  );
}

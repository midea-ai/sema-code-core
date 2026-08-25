import { useEffect, useState } from 'react';
import { Plus, Trash2, RefreshCw, Check, X, Eye, EyeOff } from 'lucide-react';
import { IconSelect } from '../../common/IconSelect';
import { useApp } from '../../store/app';
import { wsClient } from '../../api/ws';
import { Button, Modal, Toggle, Spinner, Dropdown, cn, useDialog } from '../../common/ui';
import ProviderLogo, { parseProviderKey, stripProviderSuffix } from '../../common/ProviderLogo';
import { t } from '../../i18n';
import { PROVIDERS, PROVIDER_ORDER, DEFAULT_PROVIDER, DEFAULT_MAX_TOKENS, DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_TOKENS_OPTIONS, DEFAULT_CONTEXT_LENGTH_OPTIONS, formatTokenCount, validateCustomProviderName, AdapterType } from './providers';
import { PERMISSION_LEVELS } from '../../../../shared/types';
import type { WebUISettings } from '../../../../shared/types';

export function SettingsPage({ tab }: { tab: 'models' | 'system' }) {
  const setView = useApp(s => s.setView);
  const sidebarCollapsed = useApp(s => s.sidebarCollapsed);
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className={cn('h-11 shrink-0 flex items-center gap-2 px-4 border-b border-border', sidebarCollapsed && 'pl-12')}>
        <TabBtn active={tab === 'models'} onClick={() => setView({ type: 'settings', tab: 'models' })}>{t('settings.models')}</TabBtn>
        <TabBtn active={tab === 'system'} onClick={() => setView({ type: 'settings', tab: 'system' })}>{t('settings.system')}</TabBtn>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-6">
          {tab === 'models' ? <ModelsSettings /> : <SystemSettings />}
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button onClick={onClick} className={cn('h-7 px-2.5 rounded-md text-sm', active ? 'bg-black/[0.07] text-fg' : 'text-muted hover:text-fg hover:bg-black/[0.05]')}>{children}</button>;
}

// ==================== 模型配置 ====================

function ModelsSettings() {
  const modelData = useApp(s => s.modelData);
  const refresh = useApp(s => s.refreshModelData);
  const toast = useApp(s => s.toast);
  const dialog = useDialog();
  const [adding, setAdding] = useState(false);
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

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">{t('settings.modelList')}</h2>
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}><Plus size={14} />{t('settings.addModel')}</Button>
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
                  <th className="text-left font-medium px-4 py-2 w-24">{t('settings.task.col')}</th>
                  <th className="text-right font-medium px-4 py-2 w-16">{t('settings.delete')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map(name => {
                  const provider = parseProviderKey(name);
                  const task = taskOf(name);
                  return (
                    <tr key={name} className="hover:bg-black/[0.02]">
                      <td className="px-4 py-2.5"><span className="inline-flex items-center gap-2"><ProviderLogo provider={provider} />{provider === 'custom' ? provider : (PROVIDERS[provider]?.name || provider)}</span></td>
                      <td className="px-4 py-2.5 font-mono text-[13px]">{stripProviderSuffix(name)}</td>
                      <td className="px-4 py-2.5">
                        {task === 'main' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent/10 text-accent">{t('settings.mainModel')}</span>}
                        {task === 'quick' && <span className="text-[11px] px-1.5 py-0.5 rounded bg-ok/10 text-ok">{t('settings.quickModel')}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button disabled={busy} title={t('settings.delete')} className="p-1 rounded text-muted hover:text-danger hover:bg-danger/10" onClick={async () => {
                          if (await dialog.confirm({ title: t('settings.delete'), message: `${t('settings.delete')} ${name}？`, danger: true })) run(() => wsClient.request('core.delModel', undefined, { modelName: name }));
                        }}><Trash2 size={14} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {list.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-3">{t('settings.taskConfig')}</h2>
          <div className="rounded-lg border border-border bg-white divide-y divide-border">
            <TaskRow label={t('settings.mainModel')} desc={t('settings.mainDesc')} value={main} list={list} disabled={busy} onChange={v => applyTask({ main: v, quick: quick || v })} />
            <TaskRow label={t('settings.quickModel')} desc={t('settings.quickDesc')} value={quick} list={list} disabled={busy} onChange={v => applyTask({ main: main || v, quick: v })} />
          </div>
        </section>
      )}
      <AddModelDialog open={adding} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); refresh().catch(() => undefined); }} />
    </div>
  );
}

function TaskRow({ label, desc, value, list, disabled, onChange }: { label: string; desc: string; value: string; list: string[]; disabled: boolean; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="w-28 shrink-0">
        <div className="text-sm font-medium">{label}</div>
      </div>
      <div className="flex-1 text-xs text-muted">{desc}</div>
      <Dropdown value={value} options={list.map(m => ({ value: m, label: stripProviderSuffix(m), icon: <ProviderLogo provider={parseProviderKey(m)} /> }))}
        onChange={onChange} minWidth={260}
        className={cn('h-9 px-3 border border-border rounded-md text-sm text-fg bg-white min-w-64 justify-between', disabled && 'opacity-50 pointer-events-none')}
        renderValue={v => v ? <span className="inline-flex items-center gap-2 truncate"><ProviderLogo provider={parseProviderKey(v)} />{stripProviderSuffix(v)}</span> : <span className="text-muted">—</span>} />
    </div>
  );
}

interface FetchedModel { id: string; name?: string; ownedBy?: string; key_doc_url?: string; recommended_max_tokens?: number; max_tokens?: number }

function AddModelDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useApp(s => s.toast);
  const [provider, setProvider] = useState(DEFAULT_PROVIDER);
  const [customProviderName, setCustomProviderName] = useState('');  // 打开弹窗时由 onProvider 重置
  const [baseURL, setBaseURL] = useState(PROVIDERS[DEFAULT_PROVIDER].baseURL);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [adapt, setAdapt] = useState<AdapterType>(PROVIDERS[DEFAULT_PROVIDER].defaultAdapt || 'openai');
  const [manual, setManual] = useState(false);
  const [modelName, setModelName] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS));
  const [modelMaxTokens, setModelMaxTokens] = useState<number | null>(null);
  const [contextLength, setContextLength] = useState(String(DEFAULT_CONTEXT_LENGTH));
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [tested, setTested] = useState<'none' | 'ok' | 'fail'>('none');

  const p = PROVIDERS[provider];
  const currentModel = manual ? modelName.trim() : selectedModel;
  const invalidate = () => { setTested('none'); };

  const onProvider = (k: string) => {
    const d = PROVIDERS[k];
    setProvider(k); setCustomProviderName(k === 'custom' ? 'custom' : ''); setBaseURL(d.baseURL); setApiKey(''); setModelName(''); setSelectedModel(''); setModels([]); setFetchFailed(false); setManual(false);
    setMaxTokens(String(d.defaultMaxTokens ?? DEFAULT_MAX_TOKENS)); setModelMaxTokens(null); setContextLength(String(d.defaultContextLength ?? DEFAULT_CONTEXT_LENGTH));
    setAdapt(d.defaultAdapt || 'openai'); setStatus(null); invalidate();
  };
  useEffect(() => { if (open) onProvider(DEFAULT_PROVIDER); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const applyModel = async (id: string) => {
    setSelectedModel(id); invalidate();
    const m = models.find(x => x.id === id);
    if (m?.recommended_max_tokens) setMaxTokens(String(m.recommended_max_tokens));
    setModelMaxTokens(m?.max_tokens ?? null);
    try { const ad = await wsClient.request<AdapterType | null>('core.getModelAdapter', undefined, { provider, modelName: id, baseURL }); if (ad) setAdapt(ad); } catch { /* ignore */ }
  };

  const fetchModels = async () => {
    if (!baseURL) { setStatus({ type: 'error', text: '请输入模型地址' }); return; }
    if (p.requiresApiKeyForModelList !== false && !apiKey) { setStatus({ type: 'error', text: '请输入 API Key' }); return; }
    setFetching(true); setStatus({ type: 'info', text: '正在获取模型列表...' });
    try {
      const r = await wsClient.request<any>('core.fetchAvailableModels', undefined, { params: { provider, baseURL, apiKey, adapt, modelsUrl: p.modelsUrl } });
      if (!r?.success) throw new Error(r?.message || '获取模型列表失败');
      const list: FetchedModel[] = r.models || [];
      if (!list.length) { setFetchFailed(true); setStatus({ type: 'error', text: '请求成功，但没有返回可用模型' }); return; }
      setModels(list); setFetchFailed(false);
      const pick = (p.defaultModel && list.find(m => m.id === p.defaultModel)) ? p.defaultModel! : list[0].id;
      setStatus({ type: 'ok', text: `成功获取 ${list.length} 个模型` });
      setTimeout(() => setStatus(s => s?.text.startsWith('成功获取') ? null : s), 3000);
      // 用刚拿到的列表应用默认模型（models state 尚未更新，直接读 list）
      setSelectedModel(pick); invalidate();
      const m = list.find(x => x.id === pick);
      if (m?.recommended_max_tokens) setMaxTokens(String(m.recommended_max_tokens));
      setModelMaxTokens(m?.max_tokens ?? null);
      try { const ad = await wsClient.request<AdapterType | null>('core.getModelAdapter', undefined, { provider, modelName: pick, baseURL }); if (ad) setAdapt(ad); } catch { /* ignore */ }
    } catch (e: any) { setFetchFailed(true); setStatus({ type: 'error', text: e.message }); } finally { setFetching(false); }
  };

  const testConn = async () => {
    if (!baseURL) { setStatus({ type: 'error', text: '请输入模型地址' }); return; }
    if (!apiKey) { setStatus({ type: 'error', text: '请输入 API Key' }); return; }
    if (!currentModel) { setStatus({ type: 'error', text: '请先获取模型或手动输入模型名称' }); return; }
    setTesting(true); setStatus({ type: 'info', text: '正在测试连接...' });
    try {
      const r = await wsClient.request<any>('core.testApiConnection', undefined, { params: { provider, baseURL, apiKey, modelName: currentModel, adapt } });
      setTested(r?.success ? 'ok' : 'fail');
      setStatus({ type: r?.success ? 'ok' : 'error', text: r?.success ? t('settings.testOk') : `${t('settings.testFail')}：${r?.message || ''}` });
    } catch (e: any) { setTested('fail'); setStatus({ type: 'error', text: `${t('settings.testFail')}：${e.message}` }); } finally { setTesting(false); }
  };

  const save = async () => {
    if (!apiKey) { setStatus({ type: 'error', text: '请输入 API Key' }); return; }
    if (!currentModel) { setStatus({ type: 'error', text: '请先获取模型或手动输入模型名称' }); return; }
    if (tested === 'none') { setStatus({ type: 'error', text: '请先点击「测试连接」验证配置' }); return; }
    if (tested === 'fail') { setStatus({ type: 'error', text: '连接测试未通过，请修正配置后重新测试' }); return; }
    const aliasError = provider === 'custom' ? validateCustomProviderName(customProviderName) : null;
    if (aliasError) { setStatus({ type: 'error', text: `服务商名称不合法: ${aliasError}` }); return; }
    setSaving(true);
    try {
      await wsClient.request('core.addModel', undefined, { config: { provider: provider === 'custom' && customProviderName ? customProviderName : provider, modelName: currentModel, baseURL, apiKey, maxTokens: parseInt(maxTokens), contextLength: parseInt(contextLength), adapt }, skipValidation: true });
      toast(t('settings.saved'));
      onSaved();
    } catch (e: any) { setStatus({ type: 'error', text: e.message }); } finally { setSaving(false); }
  };

  const docUrl = (selectedModel && models.find(m => m.id === selectedModel)?.key_doc_url) || p.apikeyUrl || '';
  const linkCls = 'text-xs text-accent hover:underline cursor-pointer';

  return (
    <Modal open={open} onClose={onClose} title={t('settings.addModel')} width={560}>
      <div className="flex flex-col gap-4 text-sm">
        <Field label={t('settings.provider')}>
          <IconSelect value={provider} onChange={onProvider}
            options={PROVIDER_ORDER.filter(k => PROVIDERS[k]).map(k => ({ value: k, label: PROVIDERS[k].name, icon: <ProviderLogo provider={k} /> }))} />
        </Field>
        {provider === 'custom' && (
          <Field label={t('settings.providerName')}>
            <input value={customProviderName} onChange={e => { setCustomProviderName(e.target.value.trim()); invalidate(); }}
              placeholder="为该服务命名以区分多个自定义服务，小写字母/数字/短横线，2~20 字符，留空默认为 custom"
              className="w-full h-9 px-3 rounded-md bg-white border border-border focus:border-accent" />
            {validateCustomProviderName(customProviderName) && (
              <div className="text-xs text-danger">{validateCustomProviderName(customProviderName)}</div>
            )}
          </Field>
        )}
        <Field label={t('settings.baseURL')}>
          <input value={baseURL} onChange={e => { setBaseURL(e.target.value); invalidate(); }} placeholder={p.baseURLPlaceholder || p.baseURL} className="w-full h-9 px-3 rounded-md bg-white border border-border focus:border-accent" />
        </Field>
        <Field label={t('settings.apiKey')} hint={docUrl ? <a className={linkCls} href={docUrl} target="_blank" rel="noreferrer" title={docUrl}>获取 API Key ↗</a> : undefined}>
          <div className="relative">
            <input type={showKey ? 'text' : 'password'} value={apiKey} onChange={e => { setApiKey(e.target.value.trim()); invalidate(); }} placeholder={p.apiKeyPlaceholder} className="w-full h-9 pl-3 pr-9 rounded-md bg-white border border-border focus:border-accent" />
            <button type="button" onClick={() => setShowKey(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted hover:text-fg" title={showKey ? '隐藏' : '显示'}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
          </div>
        </Field>
        <Field label={t('settings.modelName')} hint={<span className={linkCls} onClick={() => { setManual(v => !v); invalidate(); }}>{manual ? '从列表选择' : '手动输入'}</span>}>
          {manual ? (
            <input value={modelName} onChange={e => { setModelName(e.target.value); invalidate(); }} placeholder={p.defaultModel ? `输入模型名称，例如: ${p.defaultModel}` : '输入模型名称'} className="w-full h-9 px-3 rounded-md bg-white border border-border focus:border-accent" />
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex gap-2 items-center">
                <div className="flex-1 min-w-0">
                  <IconSelect value={selectedModel} onChange={applyModel} disabled={models.length === 0} placeholder="-- 请先获取模型列表 --"
                    options={models.map(m => ({ value: m.id, label: m.name || m.id }))} />
                </div>
                <Button onClick={fetchModels} disabled={fetching} className="h-9">{fetching ? <Spinner /> : <RefreshCw size={13} />}{fetching ? '获取中...' : t('settings.fetchModels')}</Button>
              </div>
              {fetchFailed && models.length === 0 && (
                <div className="text-xs text-muted">获取不到模型列表？该服务商可能不支持列出模型，可以 <span className={linkCls} onClick={() => setManual(true)}>手动输入模型名称</span></div>
              )}
            </div>
          )}
        </Field>
        <Field label={t('settings.adapt')}>
          <IconSelect value={adapt} onChange={v => setAdapt(v as AdapterType)} options={[{ value: 'openai', label: 'OpenAI 格式' }, { value: 'anthropic', label: 'Anthropic 格式' }]} />
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
          <Button variant="ghost" onClick={onClose}>{t('dialog.cancel')}</Button>
          <Button onClick={testConn} disabled={testing}>{testing ? <Spinner /> : null}{testing ? '测试中...' : t('settings.test')}</Button>
          <Button variant="primary" onClick={save} disabled={saving}>{saving ? <Spinner /> : null}{saving ? '添加中...' : t('settings.addModel')}</Button>
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

type CoreBoolKey = 'skipFileEditPermission' | 'skipShellExecPermission' | 'skipSkillPermission' | 'skipMCPToolPermission' | 'skipFetchUrlPermission' | 'skipExternalFileReadPermission' | 'disableBackgroundTasks' | 'enableToolSearch';
const BASIC_KEYS: Array<{ key: CoreBoolKey; label: string }> = [
  { key: 'enableToolSearch', label: t('settings.enableToolSearch') },
  { key: 'disableBackgroundTasks', label: t('settings.disableBg') },
];
const PERMISSION_KEYS: Array<{ key: CoreBoolKey; label: string }> = [
  { key: 'skipFileEditPermission', label: t('settings.skipFileEdit') },
  { key: 'skipShellExecPermission', label: t('settings.skipShell') },
  { key: 'skipSkillPermission', label: t('settings.skipSkill') },
  { key: 'skipMCPToolPermission', label: t('settings.skipMCP') },
  { key: 'skipFetchUrlPermission', label: t('settings.skipFetch') },
  { key: 'skipExternalFileReadPermission', label: t('settings.skipExternalRead') },
];

function SystemSettings() {
  const settings = useApp(s => s.settings);
  const save = useApp(s => s.saveSettings);
  const toast = useApp(s => s.toast);
  const [rules, setRules] = useState(settings?.coreConfig.customRules || '');
  const [savingRules, setSavingRules] = useState(false);
  useEffect(() => { setRules(settings?.coreConfig.customRules || ''); }, [settings?.coreConfig.customRules]);
  if (!settings) return null;

  const patch = async (p: Partial<WebUISettings>) => { try { await save(p); } catch (e: any) { toast(e.message, 'error'); } };
  const ToggleRow = ({ k, label }: { k: CoreBoolKey; label: string }) => (
    <div className="flex items-center justify-between px-4 py-2.5 text-sm">
      <span>{label}<span className="ml-2 text-xs text-muted font-mono">{k}</span></span>
      <Toggle checked={!!settings.coreConfig[k]} onChange={v => patch({ coreConfig: { ...settings.coreConfig, [k]: v } })} />
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-base font-semibold mb-3">{t('settings.basic')}</h2>
        <div className="rounded-lg border border-border bg-white divide-y divide-border">
          {BASIC_KEYS.map(({ key, label }) => <ToggleRow key={key} k={key} label={label} />)}
        </div>
      </section>
      <section>
        <h2 className="text-base font-semibold mb-3">{t('settings.customRules')}</h2>
        <textarea value={rules} onChange={e => setRules(e.target.value)} rows={5} className="w-full p-3 rounded-md bg-white border border-border text-sm font-mono resize-y" />
        <div className="flex justify-end mt-2">
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

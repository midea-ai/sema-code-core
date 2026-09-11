import { Globe } from 'lucide-react';
import { useApp } from '../store/app';
import { IconSelect } from './IconSelect';
import { Dropdown } from './ui';
import { useLang, setLang, normalizeLang, languageLabel, LANGS, LANGUAGES, type Language } from '../i18n';

/**
 * 界面语言下拉（设置页与未配置模型卡片共用）：选项用各语言自称，任一界面语言下都能认出。
 * compact：地球图标 + 「语言名 / Language」的小按钮（英文界面只显示 English），不认识当前语言的用户也能找到入口；
 *   用于引导卡片等次要位置；默认为表单下拉。
 * 页面立即切换，落盘后以服务端返回为准（customRules 随语言切换的规则在 server）。
 */
export function LanguageSelect({ compact, className }: { compact?: boolean; className?: string }) {
  const settings = useApp(s => s.settings);
  const save = useApp(s => s.saveSettings);
  const toast = useApp(s => s.toast);
  const lang = useLang();
  if (!settings) return null;
  const onChange = (v: string) => {
    const next = normalizeLang(v);
    if (next === lang) return;
    setLang(next);
    save({ coreConfig: { ...settings.coreConfig, lang: next } }).catch(e => { setLang(settings.coreConfig.lang); toast(e.message, 'error'); });
  };
  const options = LANGUAGES.map(l => ({ value: l, label: LANGS[l].label }));
  if (compact) {
    return (
      <Dropdown<Language> value={lang} options={options} onChange={onChange} minWidth={140} title={languageLabel()} className={className}
        renderValue={v => <><Globe size={13} />{v === 'en' ? LANGS[v].label : `${LANGS[v].label} / Language`}</>} />
    );
  }
  return <IconSelect value={lang} onChange={onChange} options={options} className={className} />;
}

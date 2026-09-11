/**
 * 界面语言注册表（client 与 server 共用，纯数据无依赖）。
 *
 * 新增语言：LANGS 加一行 → client/src/i18n 加字典并在 DICTS 注册（漏注册编译报错）。
 * 语言码需同时是 sema-core 支持的 lang（coreConfig.lang 会透传给 core，驱动权限面板等 core 文案）。
 */
export const LANGS = {
  zh: { label: '中文', htmlLang: 'zh-CN', dateLocale: 'zh-CN', customRules: '- 中文回答' },
  en: { label: 'English', htmlLang: 'en', dateLocale: 'en-US', customRules: '- Answer in English' },
  de: { label: 'Deutsch', htmlLang: 'de', dateLocale: 'de-DE', customRules: '- Antworte auf Deutsch' },
  fr: { label: 'Français', htmlLang: 'fr', dateLocale: 'fr-FR', customRules: '- Réponds en français' },
  it: { label: 'Italiano', htmlLang: 'it', dateLocale: 'it-IT', customRules: '- Rispondi in italiano' },
} as const;

export type Language = keyof typeof LANGS;

export const DEFAULT_LANG: Language = 'zh';

/** 按登记顺序排列的语言码，用于渲染语言下拉框 */
export const LANGUAGES = Object.keys(LANGS) as Language[];

/** 任意输入归一到受支持语言：取主语言码匹配（'en-US' / 'zh_CN' → en / zh），匹配不到一律 DEFAULT_LANG */
export function normalizeLang(value: unknown): Language {
  const code = typeof value === 'string' ? value.toLowerCase().split(/[-_]/)[0] : '';
  return Object.prototype.hasOwnProperty.call(LANGS, code) ? code as Language : DEFAULT_LANG;
}

/** 某语言下自定义规则的默认值 */
export function defaultCustomRules(lang: Language): string {
  return LANGS[lang].customRules;
}

/**
 * customRules 是否仍为某个语言的内置默认值（整体比较，忽略首尾空白）。
 * 切换语言时只有这种情况才替换为目标语言默认值，用户改过的规则一律不动。
 */
export function isBuiltinCustomRules(rules: unknown): boolean {
  const current = String(rules ?? '').trim();
  return LANGUAGES.some(l => LANGS[l].customRules.trim() === current);
}

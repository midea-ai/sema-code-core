/**
 * 界面文案 i18n 入口。
 *
 * - 语言来源：settings.coreConfig.lang（store 在 bootstrap / saveSettings 后调 setLang）；
 *   同时缓存到 localStorage，下次启动在 bootstrap 返回前就用上次的语言，避免首屏闪中文。
 * - 重渲染：根组件 App 用 useLang() 订阅，非 memo 组件随之重渲染；memo 组件内需自行调 useLang()。
 *   依赖文案的 useMemo 需把 lang 放进 deps。
 * - 模块顶层常量里不要调 t()（求值早于 setLang，且切换后不会更新），改存 key 或写成函数。
 * - 新增语言：shared/lang.ts 的 LANGS 加一行 → 本目录加字典（satisfies Dict）→ 在 DICTS 注册，漏写编译报错。
 */
import { useSyncExternalStore } from 'react';
import { LANGS, DEFAULT_LANG, normalizeLang, type Language } from '../../../shared/lang';
import { zh } from './zh';
import { en } from './en';
import { de } from './de';
import { fr } from './fr';
import { it } from './it';

export type I18nKey = keyof typeof zh;
export type Dict = Record<I18nKey, string>;

const DICTS: Record<Language, Dict> = { zh, en, de, fr, it };

const CACHE_KEY = 'semawork.lang';

function readCachedLang(): Language {
  try { return normalizeLang(localStorage.getItem(CACHE_KEY) ?? DEFAULT_LANG); } catch { return DEFAULT_LANG; }
}

let currentLang: Language = readCachedLang();
document.documentElement.lang = LANGS[currentLang].htmlLang;

const listeners = new Set<() => void>();

export function getLang(): Language { return currentLang; }

export function setLang(value: unknown): void {
  const next = normalizeLang(value);
  if (next === currentLang) return;
  currentLang = next;
  document.documentElement.lang = LANGS[next].htmlLang;
  try { localStorage.setItem(CACHE_KEY, next); } catch { /* ignore */ }
  listeners.forEach(fn => fn());
}

export function subscribeLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 订阅语言变化并返回当前语言 */
export function useLang(): Language {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/** 取当前语言文案；{name} 占位符由 vars 替换，缺 key 回退中文，再缺回退 key 本身 */
export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  const s = DICTS[currentLang][key] ?? zh[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m);
}

/** toLocaleDateString / toLocaleTimeString 使用的 locale */
export function dateLocale(): string { return LANGS[currentLang].dateLocale; }

/** 语言选择入口的 label：「当前语言文案 / Language」，保证任一界面语言下都能找到；英文界面只显示一次 */
export function languageLabel(): string {
  const s = t('settings.language');
  return currentLang === 'en' ? s : `${s} / Language`;
}

export { LANGS, LANGUAGES, normalizeLang } from '../../../shared/lang';
export type { Language } from '../../../shared/lang';

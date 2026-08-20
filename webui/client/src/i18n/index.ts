/** 极简 i18n：先只有中文，文案统一走 key，后续加语言只需补字典 */
import { zh } from './zh';

type Dict = typeof zh;
export type I18nKey = keyof Dict;

let dict: Record<string, string> = zh;

export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  let s = dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export function setLocale(d: Record<string, string>) { dict = d; }

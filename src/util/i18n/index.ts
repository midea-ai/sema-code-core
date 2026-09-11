/**
 * UI 可见文案的多语言入口。
 *
 * 覆盖范围：权限面板选项、Plan 退出选项、session:error / hook 通知、模型配置校验、
 * 管理接口抛错等会展示到 UI 的文案。日志、注释、提示词、给 LLM 的工具输出不走这里。
 *
 * t() 每次调用读当前 lang（ConfManager.getLanguage），updateCoreConfig({ lang }) 后即时生效。
 * 占位符形如 {name}，与 webui 的 t(key, vars) 同风格。
 *
 * 新增语言：types/index.ts 的 SUPPORTED_LANGUAGES 加值，本目录加 <lang>.ts
 * （satisfies Record<I18nKey, string>），在 MESSAGES 注册。漏译 key、漏注册均编译报错。
 */
import { getConfManager } from '../../manager/ConfManager'
import type { Language } from '../../types/index'
import { zh, type I18nKey } from './zh'
import { en } from './en'
import { de } from './de'
import { fr } from './fr'
import { it } from './it'

export type { I18nKey }

const MESSAGES: Record<Language, Record<I18nKey, string>> = { zh, en, de, fr, it }

/**
 * 按当前 lang 取文案并替换 {name} 占位符；缺 key 时回落中文，再缺返回 key 本身
 */
export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  const lang = getConfManager().getLanguage()
  let s: string = MESSAGES[lang]?.[key] ?? zh[key] ?? key
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v))
    }
  }
  return s
}

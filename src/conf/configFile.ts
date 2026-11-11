/**
 * 构造参数 configFile：把 SemaCore 的构造配置放到一个 JSON 文件里。
 *
 * - 文件内容是一个 JSON 对象，字段与 SemaCoreConfig 相同（严格 JSON，不支持注释）
 * - 构造参数里显式传了的顶层键整体覆盖文件里的同名键，不做深合并
 * - 文件内任意位置的 { "$file": "路径" } 替换成该文件的文本，用来外置长文本（系统提示词、规则、内联 skill 正文等）
 * - 路径写法：configFile 支持 ~/xx 与绝对路径；$file 另外支持相对配置文件所在目录的相对路径
 *
 * 只在构造时同步读一次；读不到或内容不合法抛 SemaError(CONFIG_INVALID)，与其他宿主配置的校验一致。
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { SemaCoreConfig } from '../types/index'
import { SemaError } from '../util/errors'

const FILE_REF_KEY = '$file'

function invalid(message: string): SemaError {
  return new SemaError('CONFIG_INVALID', message)
}

/** ~/xx 展开到用户目录，绝对路径原样；相对路径给了 baseDir 才解析，否则返回 null */
function resolvePath(p: string, baseDir?: string): string | null {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  if (path.isAbsolute(p)) return path.normalize(p)
  return baseDir ? path.resolve(baseDir, p) : null
}

function readText(filePath: string, label: string): string {
  try {
    // 去掉 UTF-8 BOM（Windows 记事本保存的文件会带），否则 JSON.parse 直接失败
    return fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '')
  } catch (e) {
    throw invalid(`${label} cannot be read: ${filePath} (${e instanceof Error ? e.message : String(e)})`)
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 递归把 { "$file": "路径" } 换成文件文本；where 是出错时指给用户看的字段位置 */
function expandFileRefs(value: unknown, baseDir: string, where: string): unknown {
  if (Array.isArray(value)) return value.map((v, i) => expandFileRefs(v, baseDir, `${where}[${i}]`))
  if (!isPlainObject(value)) return value
  if (FILE_REF_KEY in value) {
    const ref = value[FILE_REF_KEY]
    if (Object.keys(value).length !== 1 || typeof ref !== 'string' || !ref) {
      throw invalid(`${where} must be exactly { "${FILE_REF_KEY}": "<path>" }`)
    }
    return readText(resolvePath(ref, baseDir)!, `${where}.${FILE_REF_KEY}`)
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = expandFileRefs(v, baseDir, where ? `${where}.${k}` : k)
  return out
}

/**
 * 没传 configFile 时原样返回；传了则读文件并与构造参数合并，返回最终生效的构造配置。
 */
export function resolveConfigFile(config: SemaCoreConfig): SemaCoreConfig {
  const { configFile } = config
  if (configFile === undefined || configFile === null) return config
  if (typeof configFile !== 'string' || !configFile) throw invalid('configFile must be a non-empty string')

  const filePath = resolvePath(configFile)
  if (!filePath) throw invalid(`configFile must be an absolute path or start with ~/: ${configFile}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(readText(filePath, 'configFile'))
  } catch (e) {
    if (e instanceof SemaError) throw e
    throw invalid(`configFile is not valid JSON: ${filePath} (${e instanceof Error ? e.message : String(e)})`)
  }
  if (!isPlainObject(parsed)) throw invalid(`configFile must contain a JSON object: ${filePath}`)

  // 构造参数里值为 undefined 的键视为没传，不盖掉文件里的
  const explicit = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined))
  // 被构造参数整体覆盖的键先从文件内容里去掉，再展开 $file：被覆盖的项不读它引用的外部文件，引用写错或文件缺失也不报错。
  // explicit 里一定有 configFile，所以文件里写的 configFile（不支持再指向另一个配置文件）也在这里一并去掉
  const kept = Object.fromEntries(Object.entries(parsed).filter(([k]) => !(k in explicit)))
  const fromFile = expandFileRefs(kept, path.dirname(filePath), '') as Record<string, unknown>
  return { ...fromFile, ...explicit } as SemaCoreConfig
}
